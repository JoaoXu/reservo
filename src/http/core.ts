// Minimal HTTP layer on node:http: routing, body parsing, cookies,
// security headers. No framework, so there's very little to patch or audit.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { SafeHtml } from '../lib/html.ts';
import type { Tenant } from '../domain/tenants.ts';
import type { Locale } from '../lib/i18n.ts';

export interface Session { userId: string; tenantId: string; csrf: string; name: string; email: string; role: 'owner' | 'staff'; locale: Locale }

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  url: URL;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  host: string;
  ip: string;
  cookies: Record<string, string>;
  tenant: Tenant | null;
  locale: Locale;
  session: Session | null;
  nonce: string; // per-response CSP nonce for the one inline <style>
  body?: Record<string, unknown>;
  rawBody?: Buffer;
}

export interface Reply {
  status: number;
  headers?: Record<string, string | string[]>;
  body?: string | Buffer | SafeHtml;
}

export type Handler = (ctx: Ctx) => Promise<Reply> | Reply;

export class HttpError extends Error {
  readonly status: number;
  readonly expose: boolean;
  constructor(status: number, message: string, expose = true) {
    super(message);
    this.status = status;
    this.expose = expose;
  }
}

// --- Router ---------------------------------------------------------------
interface Route { method: string; parts: string[]; handler: Handler }

export class Router {
  private routes: Route[] = [];
  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
    return this;
  }
  get(p: string, h: Handler) { return this.add('GET', p, h); }
  post(p: string, h: Handler) { return this.add('POST', p, h); }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | 'method' | null {
    const segs = path.split('/').filter(Boolean);
    let methodMismatch = false;
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = r.parts[i];
        if (p.startsWith(':')) {
          try { params[p.slice(1)] = decodeURIComponent(segs[i]); } catch { ok = false; break; }
        } else if (p !== segs[i]) { ok = false; break; }
      }
      if (!ok) continue;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) { methodMismatch = true; continue; }
      return { handler: r.handler, params };
    }
    return methodMismatch ? 'method' : null;
  }
}

// --- Request helpers ------------------------------------------------------
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore bad cookie */ }
  }
  return out;
}

export function clientIp(req: IncomingMessage): string {
  const hops = config.trustProxyHops;
  if (hops > 0) {
    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    // The right-most entries were added by our own proxies.
    if (xff.length >= hops) return xff[xff.length - hops];
  }
  return req.socket.remoteAddress ?? '0.0.0.0';
}

export function requestHost(req: IncomingMessage): string {
  const fwd = config.trustProxyHops > 0 ? req.headers['x-forwarded-host'] : undefined;
  return String(fwd ?? req.headers.host ?? '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
}

export function isSecureRequest(req: IncomingMessage): boolean {
  if (config.trustProxyHops > 0) return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
  return (req.socket as { encrypted?: boolean }).encrypted === true;
}

const MAX_BODY = 64 * 1024;

export async function readBody(ctx: Ctx, limit = MAX_BODY): Promise<Record<string, unknown>> {
  if (ctx.body) return ctx.body;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of ctx.req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks);
  ctx.rawBody = raw;
  const type = String(ctx.req.headers['content-type'] ?? '').split(';')[0].trim();
  let body: Record<string, unknown> = {};
  if (type === 'application/json') {
    try {
      const parsed = JSON.parse(raw.toString('utf8') || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
    } catch { throw new HttpError(400, 'Invalid JSON'); }
  } else if (type === 'application/x-www-form-urlencoded' || type === '') {
    const params = new URLSearchParams(raw.toString('utf8'));
    for (const [k, v] of params) {
      if (k.endsWith('[]')) {
        const key = k.slice(0, -2);
        (body[key] = (body[key] as string[] | undefined) ?? []);
        (body[key] as string[]).push(v);
      } else body[k] = v;
    }
  } else throw new HttpError(415, 'Unsupported content type');
  ctx.body = body;
  return body;
}

/**
 * Blocks cross-site form posts (CSRF) for every state-changing request
 * except gateway webhooks: the browser's Origin must match the host.
 */
export function checkSameOrigin(ctx: Ctx): void {
  const origin = ctx.req.headers.origin;
  const referer = ctx.req.headers.referer;
  const source = origin ?? referer;
  if (!source) throw new HttpError(403, 'Missing origin');
  try {
    const host = new URL(source).hostname.toLowerCase();
    if (host !== ctx.host) throw new Error();
  } catch { throw new HttpError(403, 'Cross-site request blocked'); }
}

// --- Responses ------------------------------------------------------------
export function newNonce(): string {
  return randomBytes(16).toString('base64');
}

export function htmlReply(body: SafeHtml | string, status = 200, headers: Record<string, string | string[]> = {}): Reply {
  return { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers }, body: typeof body === 'string' ? body : body.value };
}

export function jsonReply(data: unknown, status = 200, headers: Record<string, string> = {}): Reply {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }, body: JSON.stringify(data) };
}

export function redirect(location: string, status = 303, headers: Record<string, string | string[]> = {}): Reply {
  // Only same-site relative redirects, to avoid open redirects.
  const safe = location.startsWith('/') && !location.startsWith('//') ? location : '/';
  return { status, headers: { location: safe, 'cache-control': 'no-store', ...headers } };
}

export function textReply(text: string, status = 200, headers: Record<string, string> = {}): Reply {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers }, body: text };
}

export function securityHeaders(ctx: Ctx, secure: boolean): Record<string, string> {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    `style-src 'self' 'nonce-${ctx.nonce}'`,
    "img-src 'self' https: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self' https://*.ifthenpay.com",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
  const h: Record<string, string> = {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'cross-origin-opener-policy': 'same-origin',
  };
  if (secure) h['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

export function cookie(name: string, value: string, opts: { maxAge?: number; httpOnly?: boolean; secure: boolean; sameSite?: 'Lax' | 'Strict' }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `SameSite=${opts.sameSite ?? 'Lax'}`];
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}
