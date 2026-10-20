// Gateway webhooks, the mock gateway used in demos, health checks and the
// cron endpoint. These live on the platform host, not on studio domains.
import { sql } from '../db.ts';
import { config } from '../config.ts';
import { log } from '../lib/log.ts';
import { safeEqual } from '../lib/crypto.ts';
import { html } from '../lib/html.ts';
import { isUuid } from '../lib/validate.ts';
import { HttpError, checkSameOrigin, htmlReply, jsonReply, readBody, redirect, textReply, type Ctx, type Reply } from '../http/core.ts';
import { enforceRateLimit } from '../http/guards.ts';
import { amountToCents, verifyCallbackKey, verifyMbwayNotificationSignature, mapMbwayStatus } from '../domain/payments/ifthenpay.ts';
import { paymentByOrderId, settlePayment } from '../domain/events.ts';
import { mockPaymentsAllowed, paymentKeys, tenantById } from '../domain/tenants.ts';
import { manageTokenFor } from '../domain/bookings.ts';
import { runJobs } from '../domain/jobs.ts';
import type { PaymentRow } from '../domain/payments/index.ts';

/**
 * ifthenpay "callback": a GET sent once a payment succeeds, with the
 * studio's anti-phishing key. Configure per studio in ifthenpay as:
 *   {PUBLIC_BASE_URL}/hooks/ifthenpay/{tenantId}?key=[ANTI_PHISHING_KEY]&orderId=[ORDER_ID]&amount=[AMOUNT]&requestId=[REQUEST_ID]&payment_datetime=[PAYMENT_DATETIME]
 * (card payments send `id` instead of `orderId`; both are accepted).
 * Any non-200 answer makes ifthenpay retry, so we only return errors for
 * things a retry could fix.
 */
export async function ifthenpayCallback(ctx: Ctx): Promise<Reply> {
  const tenantId = ctx.params.tenantId;
  if (!isUuid(tenantId)) return textReply('unknown', 404);
  await enforceRateLimit(`hook:${ctx.ip}`, 300, 60);
  const tenant = await tenantById(tenantId);
  if (!tenant || tenant.payment_provider !== 'ifthenpay') return textReply('unknown', 404);

  const q = ctx.query;
  const keys = paymentKeys(tenant);
  if (!verifyCallbackKey(keys.antiPhishingKey, q.get('key') ?? q.get('anti_phishing_key'))) {
    log.warn('callback with bad anti-phishing key', { tenant: tenant.slug, ip: ctx.ip });
    return textReply('forbidden', 403);
  }
  const orderId = q.get('orderId') ?? q.get('id') ?? q.get('order_id') ?? '';
  const payment = orderId ? await paymentByOrderId(tenant.id, orderId) : null;
  if (!payment) {
    log.warn('callback for unknown order', { tenant: tenant.slug, orderId });
    return textReply('ok'); // nothing to retry
  }
  const cents = amountToCents(q.get('amount'));
  if (cents !== payment.amount_cents) {
    log.error('callback amount mismatch', { tenant: tenant.slug, orderId, expected: payment.amount_cents, got: q.get('amount') });
    return textReply('ok');
  }
  const r = await settlePayment(payment, 'paid', `callback ${q.get('payment_datetime') ?? ''} ${q.get('payment_method') ?? ''}`.trim());
  log.info('payment confirmed by callback', { tenant: tenant.slug, orderId, method: payment.method, confirmed: r.bookingConfirmed, late: r.lateConflict });
  return textReply('ok');
}

/** MB WAY final-status notification (POST JSON, HMAC-signed with the MB WAY key). */
export async function mbwayNotification(ctx: Ctx): Promise<Reply> {
  const tenantId = ctx.params.tenantId;
  if (!isUuid(tenantId)) return textReply('unknown', 404);
  await enforceRateLimit(`hook:${ctx.ip}`, 300, 60);
  const tenant = await tenantById(tenantId);
  if (!tenant) return textReply('unknown', 404);
  const body = await readBody(ctx);
  const requestId = String(body.RequestId ?? '');
  const [payment] = await sql<PaymentRow[]>`select * from payments where tenant_id = ${tenant.id} and provider_request_id = ${requestId} and method = 'mbway'`;
  if (!payment) return textReply('ok');
  const keys = paymentKeys(tenant);
  const signature = String(ctx.req.headers['x-ifthenpay-signature'] ?? '');
  const amount = (payment.amount_cents / 100).toFixed(2);
  if (!keys.mbwayKey || !verifyMbwayNotificationSignature(keys.mbwayKey, payment.order_id, amount, requestId, signature)) {
    log.warn('mbway notification with bad signature', { tenant: tenant.slug, requestId });
    return textReply('forbidden', 403);
  }
  const s = mapMbwayStatus(String(body.Status ?? ''), String(body.Message ?? ''));
  if (s.status !== 'pending') await settlePayment(payment, s.status, `notification ${s.code} ${s.message}`);
  return textReply('ok');
}

// --- Mock gateway (demo and development only) -----------------------------
async function mockPayment(ctx: Ctx): Promise<{ payment: PaymentRow; tenantOk: boolean }> {
  const id = ctx.params.paymentId;
  if (!isUuid(id) || !ctx.tenant) throw new HttpError(404, 'Not found');
  const [payment] = await sql<PaymentRow[]>`select * from payments where id = ${id} and tenant_id = ${ctx.tenant.id} and provider = 'mock'`;
  if (!payment || !mockPaymentsAllowed(ctx.tenant)) throw new HttpError(404, 'Not found');
  return { payment, tenantOk: true };
}

export async function mockCardPage(ctx: Ctx): Promise<Reply> {
  const { payment } = await mockPayment(ctx);
  const page = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test card payment</title><link rel="stylesheet" href="/static/css/site.css"></head>
<body class="mock-gateway"><main class="section prose">
<h1>Test card payment</h1>
<p>This page stands in for the bank's card page in demo mode. No money moves.</p>
<p>Amount: €${(payment.amount_cents / 100).toFixed(2)}</p>
<form method="post" action="/pay/mock-card/${payment.id}"><input type="hidden" name="result" value="paid"><button class="btn" type="submit">Pay</button></form>
<form method="post" action="/pay/mock-card/${payment.id}"><input type="hidden" name="result" value="cancel"><button class="btn btn-quiet" type="submit">Cancel</button></form>
</main></body></html>`;
  return htmlReply(page);
}

export async function mockCardSubmit(ctx: Ctx): Promise<Reply> {
  checkSameOrigin(ctx);
  const { payment } = await mockPayment(ctx);
  const body = await readBody(ctx);
  if (body.result === 'paid') await settlePayment(payment, 'paid', 'mock card');
  else await settlePayment(payment, 'failed', 'mock card cancelled');
  const [b] = await sql<{ ref: string; id: string }[]>`select ref, id from bookings where id = ${payment.booking_id}`;
  return redirect(`/reserva/${b.ref}/pagamento?t=${manageTokenFor(b.id)}&payment=${payment.id}`);
}

/** Lets the demo show a Multibanco payment arriving. */
export async function mockMultibancoPay(ctx: Ctx): Promise<Reply> {
  checkSameOrigin(ctx);
  const { payment } = await mockPayment(ctx);
  await settlePayment(payment, 'paid', 'mock multibanco');
  return jsonReply({ ok: true });
}

// --- Ops --------------------------------------------------------------------
export function healthz(): Reply {
  return textReply('ok', 200, { 'cache-control': 'no-store' });
}

export async function readyz(): Promise<Reply> {
  try {
    await sql`select 1`;
    return textReply('ready', 200, { 'cache-control': 'no-store' });
  } catch {
    return textReply('database unavailable', 503, { 'cache-control': 'no-store' });
  }
}

/** For Cloud Scheduler / EventBridge: POST with "Authorization: Bearer <CRON_SECRET>". */
export async function cron(ctx: Ctx): Promise<Reply> {
  const auth = String(ctx.req.headers.authorization ?? '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || !safeEqual(token, config.cronSecret)) return textReply('forbidden', 403);
  const result = await runJobs();
  return jsonReply(result);
}
