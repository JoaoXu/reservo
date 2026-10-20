import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { config } from './config.ts';
import { closeDb } from './db.ts';
import { log } from './lib/log.ts';
import { html } from './lib/html.ts';
import { pickLocale } from './lib/i18n.ts';
import {
  HttpError, Router, clientIp, cookie, htmlReply, isSecureRequest, jsonReply, newNonce, parseCookies, requestHost, securityHeaders,
  type Ctx, type Handler, type Reply,
} from './http/core.ts';
import { loadSession } from './http/guards.ts';
import { tenantForHost } from './domain/tenants.ts';
import { startJobLoop } from './domain/jobs.ts';
import { homePage, policyPage, privacyPage } from './web/site.ts';
import { apiBookingStatus, apiCreateBooking, apiDays, apiRetryPayment, apiSlots, bookingIcs, bookingPage, cancelByCustomer, manageBookingPage, paymentPage } from './web/booking.ts';
import { cron, healthz, ifthenpayCallback, mbwayNotification, mockCardPage, mockCardSubmit, mockMultibancoPay, readyz } from './web/hooks.ts';
import { accountPage, changeLanguage, changePassword, loginPage, loginSubmit, logout, requireAdmin, requireOwner } from './web/admin/auth.ts';
import { adminSlots, agenda, bookingAction, bookingDetail, bookingList, bookingPay, newBookingForm, newBookingSubmit } from './web/admin/bookings.ts';
import { serviceForm, serviceSave, servicesPage, staffForm, staffSave, teamPage, timeOffAdd, timeOffDelete, timeOffPage } from './web/admin/catalog.ts';
import { settingsPage, settingsSave } from './web/admin/settings.ts';
import { customerErase, customersCsv, customersPage } from './web/admin/customers.ts';
import { sitePage } from './web/layout.ts';

// Routes that work on any host (platform domain or studio domain).
const platform = new Router()
  .get('/healthz', healthz)
  .get('/readyz', readyz)
  .post('/internal/cron', cron)
  .get('/hooks/ifthenpay/:tenantId', ifthenpayCallback)
  .post('/hooks/ifthenpay/:tenantId/mbway-notification', mbwayNotification);

// Routes on a studio's own site.
const a = requireAdmin, o = requireOwner;
const site = new Router()
  .get('/', homePage)
  .get('/marcar', bookingPage)
  .get('/privacidade', privacyPage)
  .get('/cancelamentos', policyPage)
  .get('/api/slots', apiSlots)
  .get('/api/days', apiDays)
  .post('/api/bookings', apiCreateBooking)
  .get('/api/reserva/:ref/estado', apiBookingStatus)
  .post('/api/reserva/:ref/pagar', apiRetryPayment)
  .get('/reserva/:ref', manageBookingPage)
  .get('/reserva/:ref/pagamento', paymentPage)
  .get('/reserva/:ref/calendario.ics', bookingIcs)
  .post('/reserva/:ref/cancelar', cancelByCustomer)
  .get('/pay/mock-card/:paymentId', mockCardPage)
  .post('/pay/mock-card/:paymentId', mockCardSubmit)
  .post('/pay/mock-multibanco/:paymentId', mockMultibancoPay)
  // Owner dashboard
  .get('/admin/login', loginPage)
  .post('/admin/login', loginSubmit)
  .post('/admin/logout', a(logout))
  .get('/admin', a(agenda))
  .get('/admin/bookings', a(bookingList))
  .get('/admin/bookings/new', a((ctx) => newBookingForm(ctx)))
  .post('/admin/bookings/new', a(newBookingSubmit))
  .get('/admin/bookings/:id', a(bookingDetail))
  .post('/admin/bookings/:id/action', a(bookingAction))
  .post('/admin/bookings/:id/pay', a(bookingPay))
  .get('/admin/api/slots', a(adminSlots))
  .get('/admin/services', a(servicesPage))
  .get('/admin/services/new', o((ctx) => serviceForm(ctx)))
  .post('/admin/services/new', o(serviceSave))
  .get('/admin/services/:id', o((ctx) => serviceForm(ctx)))
  .post('/admin/services/:id', o(serviceSave))
  .get('/admin/team', a(teamPage))
  .get('/admin/team/new', o((ctx) => staffForm(ctx)))
  .post('/admin/team/new', o(staffSave))
  .get('/admin/team/:id', o((ctx) => staffForm(ctx)))
  .post('/admin/team/:id', o(staffSave))
  .get('/admin/time-off', a((ctx) => timeOffPage(ctx)))
  .post('/admin/time-off', a(timeOffAdd))
  .post('/admin/time-off/:id/delete', a(timeOffDelete))
  .get('/admin/settings', o((ctx) => settingsPage(ctx)))
  .post('/admin/settings', o(settingsSave))
  .get('/admin/customers', o(customersPage))
  .get('/admin/customers.csv', o(customersCsv))
  .post('/admin/customers/:id/erase', o(customerErase))
  .get('/admin/account', a((ctx) => accountPage(ctx)))
  .post('/admin/account/password', a(changePassword))
  .post('/admin/account/language', a(changeLanguage));

// --- Static files -------------------------------------------------------------
const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');
const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
const staticCache = new Map<string, { body: Buffer; etag: string; type: string }>();

async function serveStatic(ctx: Ctx): Promise<Reply | null> {
  if (!ctx.path.startsWith('/static/')) return null;
  const rel = normalize(ctx.path.slice('/static/'.length)).replace(/^(\.\.(\/|\\|$))+/, '');
  const type = TYPES[extname(rel)];
  if (!type || rel.includes('..')) return { status: 404, body: 'Not found' };
  let entry = config.isProd ? staticCache.get(rel) : undefined;
  if (!entry) {
    const file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) return { status: 404, body: 'Not found' };
    try {
      if (!(await stat(file)).isFile()) return { status: 404, body: 'Not found' };
      const body = await readFile(file);
      entry = { body, type, etag: `"${createHash('sha1').update(body).digest('base64url').slice(0, 16)}"` };
      if (config.isProd) staticCache.set(rel, entry);
    } catch { return { status: 404, body: 'Not found' }; }
  }
  if (ctx.req.headers['if-none-match'] === entry.etag) return { status: 304, headers: { etag: entry.etag } };
  const versioned = ctx.query.has('v');
  return {
    status: 200,
    headers: {
      'content-type': entry.type, etag: entry.etag,
      'cache-control': versioned && config.isProd ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      ...(extname(rel).startsWith('.woff') ? { 'access-control-allow-origin': '*' } : {}),
    },
    body: entry.body,
  };
}

// --- Request handling ---------------------------------------------------------
function errorPage(ctx: Ctx, status: number, message: string): Reply {
  if (ctx.path.startsWith('/api/') || ctx.path.startsWith('/admin/api/') || ctx.path.startsWith('/hooks/')) return jsonReply({ error: message }, status);
  const l = ctx.locale;
  const body = html`<section class="section prose"><h1>${status === 404 ? (l === 'en' ? 'Page not found' : 'Página não encontrada') : status === 429 ? (l === 'en' ? 'Slow down' : 'Demasiados pedidos') : l === 'en' ? 'Something went wrong' : 'Algo correu mal'}</h1>
    <p>${message}</p><p><a class="btn" href="/">${l === 'en' ? 'Go to the home page' : 'Ir para o início'}</a></p></section>`;
  if (ctx.tenant) return htmlReply(sitePage(ctx, { title: String(status), body, noindex: true }), status);
  return htmlReply(html`<!doctype html><meta charset="utf-8"><title>${status}</title><p>${message}</p>`, status);
}

function chooseLocale(ctx: Ctx): { locale: 'pt' | 'en'; setCookie?: string } {
  const fallback = ctx.tenant?.default_locale ?? 'pt';
  const q = ctx.query.get('lang');
  if (q === 'pt' || q === 'en') return { locale: q, setCookie: cookie('lang', q, { maxAge: 31536000, secure: isSecureRequest(ctx.req), httpOnly: false }) };
  if (ctx.cookies.lang) return { locale: pickLocale(ctx.cookies.lang, fallback) };
  // First visit: tourists whose browser isn't Portuguese get English.
  const al = String(ctx.req.headers['accept-language'] ?? '').toLowerCase();
  if (al && !al.startsWith('pt') && fallback === 'pt') return { locale: 'en' };
  return { locale: fallback };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = performance.now();
  let url: URL;
  try { url = new URL(req.url ?? '/', 'http://x'); } catch { res.writeHead(400).end('Bad request'); return; }
  const ctx: Ctx = {
    req, res, method: req.method ?? 'GET', url, path: url.pathname.replace(/\/+$/, '') || '/', params: {}, query: url.searchParams,
    host: requestHost(req), ip: clientIp(req), cookies: parseCookies(req.headers.cookie), tenant: null, locale: 'pt', session: null, nonce: newNonce(),
  };
  const secure = isSecureRequest(req);
  let reply: Reply;
  const extraCookies: string[] = [];
  try {
    const stat = await serveStatic(ctx);
    if (stat) reply = stat;
    else {
      const p = platform.match(ctx.method, ctx.path);
      if (p && p !== 'method') {
        ctx.params = p.params;
        reply = await p.handler(ctx);
      } else {
        ctx.tenant = await tenantForHost(ctx.host);
        if (!ctx.tenant) {
          reply = htmlReply(html`<!doctype html><meta charset="utf-8"><title>Reservo</title><p>Reservo: no studio is configured for ${ctx.host}.</p>`, 404);
        } else {
          const lc = chooseLocale(ctx);
          ctx.locale = lc.locale;
          if (lc.setCookie) extraCookies.push(lc.setCookie);
          if (ctx.path.startsWith('/admin')) ctx.session = await loadSession(ctx);
          const m = site.match(ctx.method, ctx.path);
          if (m === 'method') reply = errorPage(ctx, 405, 'Method not allowed');
          else if (!m) reply = errorPage(ctx, 404, ctx.locale === 'en' ? 'This page doesn’t exist.' : 'Esta página não existe.');
          else { ctx.params = m.params; reply = await (m.handler as Handler)(ctx); }
        }
      }
    }
  } catch (err) {
    if (err instanceof HttpError) {
      reply = errorPage(ctx, err.status, err.expose ? err.message : 'Error');
    } else {
      log.error('request failed', { err, path: ctx.path, method: ctx.method, host: ctx.host });
      reply = errorPage(ctx, 500, ctx.locale === 'en' ? 'Please try again in a moment.' : 'Tente novamente dentro de momentos.');
    }
  }

  const headers: Record<string, string | string[]> = { ...securityHeaders(ctx, secure), ...(reply.headers ?? {}) };
  if (extraCookies.length) {
    const existing = headers['set-cookie'];
    headers['set-cookie'] = [...(Array.isArray(existing) ? existing : existing ? [existing] : []), ...extraCookies];
  }
  const body = reply.body === undefined ? undefined : typeof reply.body === 'string' || Buffer.isBuffer(reply.body) ? reply.body : reply.body.value;
  if (!res.headersSent) {
    res.writeHead(reply.status, headers);
    res.end(ctx.method === 'HEAD' ? undefined : body);
  }
  const ms = Math.round(performance.now() - started);
  if (!ctx.path.startsWith('/static/') && ctx.path !== '/healthz') {
    log.info('http', { method: ctx.method, path: ctx.path, status: reply.status, ms, host: ctx.host, tenant: ctx.tenant?.slug });
  }
}

export function createAppServer() {
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000, keepAliveTimeout: 65_000 }, (req, res) => {
    handle(req, res).catch((err) => {
      log.error('unhandled', { err });
      if (!res.headersSent) res.writeHead(500).end('Internal error');
    });
  });
  return server;
}

import { isMain } from './lib/main.ts';
if (isMain(import.meta.url)) {
  const server = createAppServer();
  server.listen(config.port, () => log.info('listening', { port: config.port, env: config.env }));
  const stopJobs = config.inlineWorker ? startJobLoop() : () => {};
  const shutdown = (sig: string) => {
    log.info('shutting down', { sig });
    stopJobs();
    server.close(async () => { await closeDb(); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
