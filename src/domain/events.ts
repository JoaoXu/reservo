// What happens after state changes: messages to customers and owners.
// Kept apart from the core logic so a slow email API never holds a
// database transaction open.
import { sql } from '../db.ts';
import { log } from '../lib/log.ts';
import { notifyCancelled, notifyConfirmed, notifyLatePayment, notifyMultibanco } from './notify.ts';
import { applyPaymentOutcome, queryMbwayStatus, type OutcomeResult, type PaymentRow, type PaymentStatus } from './payments/index.ts';
import type { Tenant } from './tenants.ts';
import type { CreatedBooking } from './bookings.ts';

function background(label: string, p: Promise<unknown>): void {
  p.catch((err) => log.error(`${label} failed`, { err }));
}

export function afterBookingCreated(tenantId: string, created: CreatedBooking): void {
  const b = created.booking;
  if (b.status === 'confirmed') background('notify confirmed', notifyConfirmed(tenantId, b.id));
  else if (created.payment?.method === 'multibanco') background('notify multibanco', notifyMultibanco(tenantId, b.id, created.payment));
}

export async function afterPaymentOutcome(tenantId: string, r: OutcomeResult, amountCents: number): Promise<void> {
  if (r.bookingConfirmed) background('notify confirmed', notifyConfirmed(tenantId, r.bookingId));
  if (r.lateConflict) background('notify late payment', notifyLatePayment(tenantId, r.bookingId, amountCents));
}

/** Applies an outcome and triggers its messages. */
export async function settlePayment(p: PaymentRow, outcome: 'paid' | 'failed' | 'expired', detail: string): Promise<OutcomeResult> {
  const r = await applyPaymentOutcome(p.id, outcome, detail);
  if (r.changed) await afterPaymentOutcome(p.tenant_id, r, p.amount_cents);
  return r;
}

export function afterBookingCancelled(tenantId: string, bookingId: string, by: 'customer' | 'owner'): void {
  background('notify cancelled', notifyCancelled(tenantId, bookingId, by));
}

export async function paymentByOrderId(tenantId: string, orderId: string): Promise<PaymentRow | null> {
  const rows = await sql<PaymentRow[]>`select * from payments where tenant_id = ${tenantId} and order_id = ${orderId}`;
  return rows[0] ?? null;
}

/** Polls the gateway for an MB WAY payment and settles it if it finished. */
export async function refreshMbway(t: Tenant, p: PaymentRow): Promise<PaymentStatus> {
  const r = await queryMbwayStatus(t, p);
  if (r.status === 'paid' || r.status === 'failed' || r.status === 'expired') {
    if (p.status === 'pending') await settlePayment(p, r.status, r.detail);
  }
  return r.status;
}
