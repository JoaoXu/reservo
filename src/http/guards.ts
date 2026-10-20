// Rate limiting and admin sessions, both stored in Postgres so they work
// the same with one app instance or twenty.
import { sql } from '../db.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { HttpError, cookie, isSecureRequest, type Ctx, type Session } from './core.ts';

/** Fixed-window limiter: at most `max` hits per `windowSec` for `key`. */
export async function rateLimit(key: string, max: number, windowSec: number): Promise<boolean> {
  const [row] = await sql<{ hits: number }[]>`
    insert into rate_limits as r (key, window_start, hits) values (${key}, now(), 1)
    on conflict (key) do update set
      hits = case when r.window_start < now() - make_interval(secs => ${windowSec}) then 1 else r.hits + 1 end,
      window_start = case when r.window_start < now() - make_interval(secs => ${windowSec}) then now() else r.window_start end
    returning hits`;
  return row.hits <= max;
}

export async function enforceRateLimit(key: string, max: number, windowSec: number): Promise<void> {
  if (!(await rateLimit(key, max, windowSec))) throw new HttpError(429, 'Too many requests');
}

const SESSION_DAYS = 14;

export function sessionCookieName(ctx: Ctx): string {
  // __Host- cookies can't be set by subdomains or over plain HTTP.
  return isSecureRequest(ctx.req) ? '__Host-rsid' : 'rsid';
}

export async function createSession(ctx: Ctx, userId: string, tenantId: string): Promise<string> {
  const token = randomToken(32);
  const csrf = randomToken(24);
  await sql`insert into sessions (id_hash, user_id, tenant_id, csrf_token, expires_at)
            values (${sha256(token)}, ${userId}, ${tenantId}, ${csrf}, now() + make_interval(days => ${SESSION_DAYS}))`;
  return cookie(sessionCookieName(ctx), token, { maxAge: SESSION_DAYS * 86400, secure: isSecureRequest(ctx.req), sameSite: 'Lax' });
}

export async function loadSession(ctx: Ctx): Promise<Session | null> {
  const token = ctx.cookies[sessionCookieName(ctx)];
  if (!token || !ctx.tenant) return null;
  const rows = await sql<{ user_id: string; tenant_id: string; csrf_token: string; name: string; email: string; role: 'owner' | 'staff'; locale: 'pt' | 'en' }[]>`
    select s.user_id, s.tenant_id, s.csrf_token, u.name, u.email, u.role, u.locale
    from sessions s join users u on u.id = s.user_id
    where s.id_hash = ${sha256(token)} and s.expires_at > now() and s.tenant_id = ${ctx.tenant.id}`;
  const r = rows[0];
  return r ? { userId: r.user_id, tenantId: r.tenant_id, csrf: r.csrf_token, name: r.name, email: r.email, role: r.role, locale: r.locale } : null;
}

export async function destroySession(ctx: Ctx): Promise<string> {
  const token = ctx.cookies[sessionCookieName(ctx)];
  if (token) await sql`delete from sessions where id_hash = ${sha256(token)}`;
  return cookie(sessionCookieName(ctx), '', { maxAge: 0, secure: isSecureRequest(ctx.req) });
}

/** Admin POSTs must carry the session's CSRF token as well as a same-origin header. */
export function checkCsrf(ctx: Ctx, body: Record<string, unknown>): void {
  if (!ctx.session || body._csrf !== ctx.session.csrf) throw new HttpError(403, 'Invalid form token. Reload the page and try again.');
}
