// Payment orchestration: which methods a booking can use, starting a
// payment with the studio's gateway, and applying the gateway's answer.
// Every path that learns a payment's outcome (callback, MB WAY
// notification, status polling, background reconcile, owner marking it
// paid) goes through applyPaymentOutcome, which is idempotent.
import { sql } from '../../db.ts';
import { config } from '../../config.ts';
import { log } from '../../lib/log.ts';
import { shortCode } from '../../lib/crypto.ts';
import { isPortugueseMobile } from '../../lib/validate.ts';
import { localDateStr, parseDateStr } from '../../lib/time.ts';
import { createIfthenpayClient, GatewayError, type IfthenpayKeys } from './ifthenpay.ts';
import { paymentKeys, mockPaymentsAllowed, tenantBaseUrl, type Tenant } from '../tenants.ts';

export type OnlineMethod = 'mbway' | 'multibanco' | 'card';
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'refunded';

export interface PaymentRow {
  id: string;
  tenant_id: string;
  booking_id: string;
  provider: 'mock' | 'ifthenpay' | 'manual';
  method: 'mbway' | 'multibanco' | 'card' | 'cash' | 'card_terminal' | 'transfer';
  order_id: string;
  amount_cents: number;
  status: PaymentStatus;
  provider_request_id: string | null;
  mb_entity: string | null;
  mb_reference: string | null;
  phone: string | null;
  expires_at: Date | null;
  paid_at: Date | null;
  last_checked_at: Date | null;
  status_detail: string | null;
  created_at: Date;
}

const CARD_HOLD_MIN = 30;
// A Multibanco reference is only offered when the customer has time to pay
// it and the studio still has time to react before the appointment.
const MULTIBANCO_MIN_SAFETY_HOURS = 3;

export function holdMinutesFor(t: Tenant, method: OnlineMethod): number {
  if (method === 'mbway') return t.mbway_hold_min;
  if (method === 'card') return CARD_HOLD_MIN;
  return t.multibanco_hold_hours * 60;
}

/** Online methods this studio can take for an appointment at `startsAt`. */
export function availableMethods(t: Tenant, startsAt: Date, now = new Date(), keys: IfthenpayKeys = paymentKeys(t)): OnlineMethod[] {
  if (t.payment_mode === 'none') return [];
  let enabled: OnlineMethod[];
  if (t.payment_provider === 'mock' && mockPaymentsAllowed(t)) enabled = ['mbway', 'multibanco', 'card'];
  else if (t.payment_provider === 'ifthenpay') {
    enabled = [];
    if (keys.mbwayKey) enabled.push('mbway');
    if (keys.mbKey) enabled.push('multibanco');
    if (keys.ccardKey) enabled.push('card');
  } else enabled = [];
  const hoursAhead = (startsAt.getTime() - now.getTime()) / 3_600_000;
  return enabled.filter((m) => m !== 'multibanco' || hoursAhead >= t.multibanco_hold_hours + MULTIBANCO_MIN_SAFETY_HOURS);
}

export function amountDue(t: Tenant, priceCents: number): number {
  if (t.payment_mode === 'none' || priceCents === 0) return 0;
  if (t.payment_mode === 'full') return priceCents;
  const dep = Math.round((priceCents * t.deposit_percent) / 100);
  return Math.min(priceCents, Math.max(100, dep)); // at least €1
}

export function newOrderId(): string {
  return 'R' + shortCode(11); // gateway limit is 15 characters
}

function callbackUrls(t: Tenant) {
  const base = config.publicBaseUrl.replace(/\/$/, '');
  return {
    mbwayNotification: `${base}/hooks/ifthenpay/${t.id}/mbway-notification`,
  };
}

/** Days until the reference should expire, in ifthenpay's terms (0 = end of today). */
export function multibancoExpiryDays(holdUntil: Date, tz: string, now = new Date()): number {
  const [y1, m1, d1] = parseDateStr(localDateStr(now, tz));
  const [y2, m2, d2] = parseDateStr(localDateStr(holdUntil, tz));
  const days = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
  const allowed = [...Array.from({ length: 33 }, (_, i) => i), 45, 60, 90, 120];
  return allowed.find((a) => a >= days) ?? 120;
}

export class PaymentStartError extends Error {
  readonly code: string;
  constructor(message: string, code: string) { super(message); this.code = code; }
}

export interface StartPaymentInput {
  tenant: Tenant;
  bookingId: string;
  bookingRef: string;
  method: OnlineMethod;
  amountCents: number;
  phone: string;
  email: string | null;
  locale: 'pt' | 'en';
  holdUntil: Date;
  manageUrl: string;
}

/** Creates the payment row and asks the gateway for an MB WAY push, reference or card page. */
export async function startPayment(p: StartPaymentInput): Promise<PaymentRow & { payment_url?: string }> {
  const t = p.tenant;
  const useMock = t.payment_provider === 'mock' && mockPaymentsAllowed(t);
  if (!useMock && t.payment_provider !== 'ifthenpay') throw new PaymentStartError('Online payments are off', 'not_configured');
  if (p.method === 'mbway' && !isPortugueseMobile(p.phone)) throw new PaymentStartError('MB WAY needs a Portuguese mobile number', 'invalid_phone');

  const orderId = newOrderId();
  const provider = useMock ? 'mock' : 'ifthenpay';
  const [row] = await sql<PaymentRow[]>`
    insert into payments (tenant_id, booking_id, provider, method, order_id, amount_cents, phone, expires_at)
    values (${t.id}, ${p.bookingId}, ${provider}, ${p.method === 'card' ? 'card' : p.method}, ${orderId}, ${p.amountCents},
            ${p.method === 'mbway' ? p.phone : null}, ${p.holdUntil})
    returning *`;

  const description = `${t.name} ${p.bookingRef}`;
  try {
    if (useMock) {
      if (p.method === 'mbway') {
        return await updateRow(row.id, { provider_request_id: 'MOCK' + shortCode(10) });
      }
      if (p.method === 'multibanco') {
        const reference = String(Math.floor(100_000_000 + Math.random() * 899_999_999));
        return await updateRow(row.id, { provider_request_id: 'MOCK' + shortCode(10), mb_entity: '12345', mb_reference: reference });
      }
      const updated = await updateRow(row.id, { provider_request_id: 'MOCK' + shortCode(10) });
      return { ...updated, payment_url: `/pay/mock-card/${row.id}` };
    }

    const client = createIfthenpayClient(paymentKeys(t));
    if (p.method === 'mbway') {
      const r = await client.mbwayRequest({
        orderId, amountCents: p.amountCents, phoneE164: p.phone, email: p.email, description,
        notificationUrl: callbackUrls(t).mbwayNotification,
      });
      return await updateRow(row.id, { provider_request_id: r.requestId });
    }
    if (p.method === 'multibanco') {
      const r = await client.multibancoReference({
        orderId, amountCents: p.amountCents, description, expiryDays: multibancoExpiryDays(p.holdUntil, t.timezone),
      });
      return await updateRow(row.id, { provider_request_id: r.requestId, mb_entity: r.entity, mb_reference: r.reference });
    }
    const site = tenantBaseUrl(t);
    const back = `${site}/reserva/${encodeURIComponent(p.bookingRef)}/pagamento?payment=${row.id}`;
    const r = await client.cardPayment({
      orderId, amountCents: p.amountCents, language: p.locale,
      successUrl: back + '&result=success', errorUrl: back + '&result=error', cancelUrl: back + '&result=cancel',
    });
    const updated = await updateRow(row.id, { provider_request_id: r.requestId });
    return { ...updated, payment_url: r.paymentUrl };
  } catch (err) {
    await sql`update payments set status = 'failed', status_detail = ${String((err as Error).message).slice(0, 200)} where id = ${row.id}`;
    log.warn('payment start failed', { tenant: t.slug, method: p.method, err });
    if (err instanceof GatewayError) {
      throw new PaymentStartError(err.message, err.code.startsWith('mbway_') ? 'mbway_refused' : err.code);
    }
    throw new PaymentStartError('Payment provider unavailable', 'gateway_error');
  }
}

async function updateRow(id: string, fields: Partial<Pick<PaymentRow, 'provider_request_id' | 'mb_entity' | 'mb_reference'>>): Promise<PaymentRow> {
  const [row] = await sql<PaymentRow[]>`
    update payments set
      provider_request_id = coalesce(${fields.provider_request_id ?? null}, provider_request_id),
      mb_entity = coalesce(${fields.mb_entity ?? null}, mb_entity),
      mb_reference = coalesce(${fields.mb_reference ?? null}, mb_reference)
    where id = ${id} returning *`;
  return row;
}

export interface OutcomeResult {
  changed: boolean;
  bookingConfirmed: boolean;
  lateConflict: boolean; // paid after the slot was given to someone else
  bookingId: string;
}

/**
 * Applies a payment outcome exactly once. Safe to call concurrently from a
 * callback and a status poll for the same payment.
 */
export async function applyPaymentOutcome(paymentId: string, outcome: 'paid' | 'failed' | 'expired', detail = ''): Promise<OutcomeResult> {
  return sql.begin(async (tx) => {
    const [p] = await tx<PaymentRow[]>`select * from payments where id = ${paymentId} for update`;
    if (!p) throw new Error('payment not found');
    const result: OutcomeResult = { changed: false, bookingConfirmed: false, lateConflict: false, bookingId: p.booking_id };
    if (p.status === 'paid' || p.status === 'refunded') return result; // final
    if (outcome !== 'paid') {
      if (p.status !== 'pending') return result;
      await tx`update payments set status = ${outcome}, status_detail = ${detail.slice(0, 200)}, last_checked_at = now() where id = ${p.id}`;
      result.changed = true;
      return result;
    }

    await tx`update payments set status = 'paid', paid_at = now(), status_detail = ${detail.slice(0, 200)} where id = ${p.id}`;
    result.changed = true;
    const [b] = await tx<{ id: string; status: string; cancel_reason: string | null }[]>`
      select id, status, cancel_reason from bookings where id = ${p.booking_id} for update`;
    if (b.status === 'pending_payment') {
      await tx`update bookings set status = 'confirmed', paid_cents = paid_cents + ${p.amount_cents},
                 hold_expires_at = null, updated_at = now() where id = ${b.id}`;
      result.bookingConfirmed = true;
    } else if (b.status === 'cancelled' && b.cancel_reason === 'hold_expired') {
      // Paid late (e.g. Multibanco after the hold ran out). Re-instate the
      // booking if the slot is still free; otherwise flag it for the owner.
      try {
        await tx.savepoint(async (sp) => {
          await sp`update bookings set status = 'confirmed', paid_cents = paid_cents + ${p.amount_cents},
                     hold_expires_at = null, cancelled_at = null, cancel_reason = null, updated_at = now()
                   where id = ${b.id}`;
        });
        result.bookingConfirmed = true;
      } catch (err) {
        if ((err as { code?: string }).code !== '23P01') throw err;
        await tx`update bookings set paid_cents = paid_cents + ${p.amount_cents}, cancel_reason = 'paid_after_slot_taken', updated_at = now() where id = ${b.id}`;
        result.lateConflict = true;
      }
    } else {
      await tx`update bookings set paid_cents = paid_cents + ${p.amount_cents}, updated_at = now() where id = ${b.id}`;
    }
    await tx`insert into audit_log (tenant_id, action, details) values (${p.tenant_id}, 'payment.paid', ${tx.json({ payment: p.id, booking: p.booking_id, method: p.method, amount: p.amount_cents, detail })})`;
    return result;
  });
}

/** Asks the gateway about a pending MB WAY payment (used by polling and reconcile). */
export async function queryMbwayStatus(t: Tenant, p: PaymentRow): Promise<{ status: PaymentStatus; detail: string }> {
  if (p.status !== 'pending' || p.method !== 'mbway' || !p.provider_request_id) return { status: p.status, detail: '' };
  if (p.provider === 'mock') {
    // Demo behaviour: numbers ending in 0000 decline, others approve after 6 s.
    const age = Date.now() - new Date(p.created_at).getTime();
    if (p.phone?.endsWith('0000')) return { status: 'failed', detail: 'mock: declined' };
    return age > 6000 ? { status: 'paid', detail: 'mock: approved' } : { status: 'pending', detail: '' };
  }
  const r = await createIfthenpayClient(paymentKeys(t)).mbwayStatus(p.provider_request_id);
  await sql`update payments set last_checked_at = now() where id = ${p.id}`;
  return { status: r.status, detail: `${r.code} ${r.message}`.trim() };
}
