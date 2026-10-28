import { sql, isDeadlock, isExclusionViolation, isUniqueViolation, type Tx } from '../db.ts';
import { log } from '../lib/log.ts';
import { randomUUID } from 'node:crypto';
import { hmacSha256Hex, safeEqual, sha256, shortCode } from '../lib/crypto.ts';
import { config } from '../config.ts';
import { addDays, localDateStr, weekdayOf } from '../lib/time.ts';
import { computeSlots, dayBounds, type Slot, type StaffSchedule } from './availability.ts';
import { amountDue, availableMethods, holdMinutesFor, startPayment, PaymentStartError, type OnlineMethod, type PaymentRow } from './payments/index.ts';
import { tenantBaseUrl, type Tenant } from './tenants.ts';

export interface Service {
  id: string; category: string; category_en: string; name_pt: string; name_en: string; description_pt: string; description_en: string;
  duration_min: number; buffer_min: number; price_cents: number; active: boolean; sort: number;
}
export interface Staff {
  id: string; tenant_id: string; name: string; title_pt: string; title_en: string; bio_pt: string; bio_en: string;
  photo_file: string | null; active: boolean; sort: number;
}

export async function listServices(tenantId: string, activeOnly = true): Promise<Service[]> {
  return sql<Service[]>`select * from services where tenant_id = ${tenantId} ${activeOnly ? sql`and active` : sql``} order by sort, name_pt`;
}

export async function listStaff(tenantId: string, activeOnly = true): Promise<Staff[]> {
  return sql<Staff[]>`select * from staff where tenant_id = ${tenantId} ${activeOnly ? sql`and active` : sql``} order by sort, name`;
}

export async function staffForService(tenantId: string, serviceId: string): Promise<Staff[]> {
  return sql<Staff[]>`
    select s.* from staff s join staff_services ss on ss.staff_id = s.id
    where s.tenant_id = ${tenantId} and ss.service_id = ${serviceId} and s.active
    order by s.sort, s.name`;
}

export async function serviceStaffMap(tenantId: string): Promise<Record<string, string[]>> {
  const rows = await sql<{ service_id: string; staff_id: string }[]>`
    select ss.service_id, ss.staff_id from staff_services ss join staff s on s.id = ss.staff_id
    where ss.tenant_id = ${tenantId} and s.active`;
  const map: Record<string, string[]> = {};
  for (const r of rows) (map[r.service_id] ??= []).push(r.staff_id);
  return map;
}

/** Loads everything the slot engine needs for one day, in three queries. */
async function schedulesFor(tx: Tx, tenant: Tenant, staffIds: string[], date: string, bufferMin: number): Promise<StaffSchedule[]> {
  if (!staffIds.length) return [];
  const wd = weekdayOf(date);
  const day = dayBounds(date, tenant.timezone);
  // Pad by the longest possible appointment so an earlier booking that runs
  // into this day is seen.
  const from = new Date(day.start - 12 * 3_600_000), to = new Date(day.end + 12 * 3_600_000);
  const [hours, bookings, off] = await Promise.all([
    tx<{ staff_id: string; start_min: number; end_min: number }[]>`
      select staff_id, start_min, end_min from working_hours
      where tenant_id = ${tenant.id} and weekday = ${wd} and staff_id in ${tx(staffIds)} order by start_min`,
    tx<{ staff_id: string; starts_at: Date; blocked_until: Date }[]>`
      select staff_id, starts_at, blocked_until from bookings
      where tenant_id = ${tenant.id} and staff_id in ${tx(staffIds)}
        and status in ('pending_payment','confirmed')
        and (status <> 'pending_payment' or hold_expires_at is null or hold_expires_at > now())
        and starts_at < ${to} and blocked_until > ${from}`,
    tx<{ staff_id: string | null; starts_at: Date; ends_at: Date }[]>`
      select staff_id, starts_at, ends_at from time_off
      where tenant_id = ${tenant.id} and (staff_id is null or staff_id in ${tx(staffIds)})
        and starts_at < ${to} and ends_at > ${from}`,
  ]);
  void bufferMin;
  return staffIds.map((id) => ({
    staffId: id,
    hours: hours.filter((h) => h.staff_id === id),
    busy: [
      ...bookings.filter((b) => b.staff_id === id).map((b) => ({ start: b.starts_at.getTime(), end: b.blocked_until.getTime() })),
      ...off.filter((o) => o.staff_id === null || o.staff_id === id).map((o) => ({ start: o.starts_at.getTime(), end: o.ends_at.getTime() })),
    ],
  }));
}

export interface SlotsResult { slots: Slot[]; service: Service; staff: Staff[] }

export async function getSlots(tenant: Tenant, serviceId: string, date: string, staffId: string | null, opts: { now?: Date; ignoreRules?: boolean } = {}): Promise<SlotsResult | null> {
  const [service] = await sql<Service[]>`select * from services where tenant_id = ${tenant.id} and id = ${serviceId} and active`;
  if (!service) return null;
  let staff = await staffForService(tenant.id, serviceId);
  if (staffId) staff = staff.filter((s) => s.id === staffId);
  const schedules = await schedulesFor(sql, tenant, staff.map((s) => s.id), date, service.buffer_min);
  const slots = computeSlots({
    date, tz: tenant.timezone,
    durationMin: service.duration_min, bufferMin: service.buffer_min,
    slotIntervalMin: tenant.slot_interval_min,
    now: opts.now ?? new Date(),
    minLeadMin: opts.ignoreRules ? 0 : tenant.min_lead_min,
    maxAdvanceDays: opts.ignoreRules ? 3650 : tenant.max_advance_days,
  }, schedules);
  return { slots, service, staff };
}

/** First few open times across the next days, for the home page. */
export async function nextOpenings(tenant: Tenant, serviceId: string, maxSlots = 6, maxDays = 7): Promise<{ date: string; start: Date }[]> {
  const out: { date: string; start: Date }[] = [];
  let date = localDateStr(new Date(), tenant.timezone);
  for (let i = 0; i < maxDays && out.length < maxSlots; i++, date = addDays(date, 1)) {
    const r = await getSlots(tenant, serviceId, date, null);
    if (!r) break;
    // Spread the picks across the day instead of showing 10:00, 10:15, 10:30
    let last = 0, perDay = 0;
    for (const s of r.slots) {
      if (s.start.getTime() - last < 90 * 60_000) continue;
      if (++perDay > 3) break;
      out.push({ date, start: s.start });
      last = s.start.getTime();
      if (out.length >= maxSlots) break;
    }
  }
  return out;
}

export class BookingError extends Error {
  readonly code: string;
  constructor(code: string, message = code) { super(message); this.code = code; }
}

export interface CreateBookingInput {
  serviceId: string;
  staffId: string | null; // null = any available therapist
  start: Date;
  customer: { name: string; phone: string; email: string | null; locale: 'pt' | 'en'; note: string; marketingConsent: boolean };
  source: 'online' | 'admin';
  // 'studio' = pay on the day; online methods start a payment
  payment: OnlineMethod | 'studio' | 'none';
  mbwayPhone?: string; // when the MB WAY account is on a different number
  ignoreRules?: boolean; // owner booking outside the online rules (still no overlaps)
  now?: Date;
}

export interface CreatedBooking {
  booking: BookingRow;
  manageToken: string;
  payment: (PaymentRow & { payment_url?: string }) | null;
}

export interface BookingRow {
  id: string; tenant_id: string; ref: string; customer_id: string; staff_id: string; service_id: string;
  starts_at: Date; ends_at: Date; blocked_until: Date;
  status: 'pending_payment' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';
  source: 'online' | 'admin'; price_cents: number; amount_due_cents: number; paid_cents: number;
  hold_expires_at: Date | null; customer_note: string; manage_token_hash: string; locale: 'pt' | 'en';
  reminder_sent_at: Date | null; cancelled_at: Date | null; cancel_reason: string | null; created_at: Date;
}

export async function createBooking(tenant: Tenant, input: CreateBookingInput): Promise<CreatedBooking> {
  const now = input.now ?? new Date();
  const date = localDateStr(input.start, tenant.timezone);
  const result = await getSlots(tenant, input.serviceId, date, input.staffId, { now, ignoreRules: input.ignoreRules });
  if (!result) throw new BookingError('service_not_found');
  const { service } = result;

  let candidates: string[];
  if (input.ignoreRules) {
    // The owner may book outside working hours, but only for therapists who do this service.
    candidates = input.staffId ? result.staff.filter((s) => s.id === input.staffId).map((s) => s.id) : result.staff.map((s) => s.id);
  } else {
    const slot = result.slots.find((s) => s.start.getTime() === input.start.getTime());
    if (!slot) throw new BookingError('slot_unavailable');
    candidates = slot.staffIds;
  }
  if (!candidates.length) throw new BookingError('slot_unavailable');

  // Payment rules
  let due = 0;
  let method: OnlineMethod | null = null;
  if (input.payment !== 'none' && input.payment !== 'studio') {
    const allowed = availableMethods(tenant, input.start, now);
    if (!allowed.includes(input.payment)) throw new BookingError('payment_method_unavailable');
    method = input.payment;
    due = amountDue(tenant, service.price_cents);
  } else if (input.source === 'online' && tenant.payment_mode !== 'none' && amountDue(tenant, service.price_cents) > 0) {
    const allowed = availableMethods(tenant, input.start, now);
    // Online customers can only skip paying if the studio allows it, or if no
    // online method is available for this appointment.
    if (!tenant.pay_at_studio_allowed && allowed.length) throw new BookingError('payment_required');
  }
  if (due === 0) method = null;

  const holdUntil = method ? new Date(now.getTime() + holdMinutesFor(tenant, method) * 60_000) : null;
  const ends = new Date(input.start.getTime() + service.duration_min * 60_000);
  const blocked = new Date(ends.getTime() + service.buffer_min * 60_000);
  const bookingId = randomUUID();
  const manageToken = manageTokenFor(bookingId);

  const booking = await sql.begin(async (tx) => {
    const c = input.customer;
    const [customer] = await tx<{ id: string }[]>`
      insert into customers (tenant_id, name, phone, email, locale, privacy_accepted_at, marketing_consent)
      values (${tenant.id}, ${c.name}, ${c.phone}, ${c.email}, ${c.locale}, ${input.source === 'online' ? now : null}, ${c.marketingConsent})
      on conflict (tenant_id, phone) where anonymized_at is null do update set
        name = excluded.name,
        email = coalesce(excluded.email, customers.email),
        locale = excluded.locale,
        privacy_accepted_at = coalesce(excluded.privacy_accepted_at, customers.privacy_accepted_at),
        marketing_consent = customers.marketing_consent or excluded.marketing_consent
      returning id`;

    // Free up holds that ran out but the background job hasn't swept yet.
    const released = await tx<{ id: string }[]>`
      update bookings set status = 'cancelled', cancel_reason = 'hold_expired', cancelled_at = now(), updated_at = now()
      where tenant_id = ${tenant.id} and status = 'pending_payment' and hold_expires_at < now()
        and staff_id in ${tx(candidates)} and starts_at < ${blocked} and blocked_until > ${input.start}
      returning id`;
    if (released.length) {
      await tx`update payments set status = 'expired', status_detail = 'hold expired'
               where status = 'pending' and booking_id in ${tx(released.map((r) => r.id))}`;
    }

    // With "any therapist", prefer whoever has the lightest day.
    let order = candidates;
    if (!input.staffId && candidates.length > 1) {
      const day = dayBounds(date, tenant.timezone);
      const load = await tx<{ staff_id: string; n: number }[]>`
        select staff_id, count(*)::int as n from bookings
        where tenant_id = ${tenant.id} and staff_id in ${tx(candidates)} and status in ('pending_payment','confirmed')
          and starts_at >= ${new Date(day.start)} and starts_at < ${new Date(day.end)}
        group by staff_id`;
      const n = new Map(load.map((l) => [l.staff_id, l.n]));
      order = [...candidates].sort((a, b) => (n.get(a) ?? 0) - (n.get(b) ?? 0));
    }

    for (const staffId of order) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await tx.savepoint(async (sp) => {
            const [row] = await sp<BookingRow[]>`
              insert into bookings (id, tenant_id, ref, customer_id, staff_id, service_id, starts_at, ends_at, blocked_until,
                status, source, price_cents, amount_due_cents, hold_expires_at, customer_note, manage_token_hash, locale)
              values (${bookingId}, ${tenant.id}, ${shortCode(6)}, ${customer.id}, ${staffId}, ${service.id}, ${input.start}, ${ends}, ${blocked},
                ${method ? 'pending_payment' : 'confirmed'}, ${input.source}, ${service.price_cents}, ${due}, ${holdUntil},
                ${c.note}, ${sha256(manageToken)}, ${c.locale})
              returning *`;
            return row;
          });
        } catch (err) {
          if (isExclusionViolation(err)) break; // this therapist was just taken, try the next one
          if (isUniqueViolation(err)) continue; // booking ref collision, retry with a new one
          if (isDeadlock(err)) continue; // raced another booking for this therapist; retry and see who won
          throw err;
        }
      }
    }
    throw new BookingError('slot_unavailable');
  });

  await sql`insert into audit_log (tenant_id, action, details) values (${tenant.id}, 'booking.created', ${sql.json({ booking: booking.id, source: input.source, method })})`;

  let payment: CreatedBooking['payment'] = null;
  if (method && holdUntil) {
    try {
      payment = await startPayment({
        tenant, bookingId: booking.id, bookingRef: booking.ref, method, amountCents: due,
        phone: input.mbwayPhone || input.customer.phone, email: input.customer.email, locale: input.customer.locale, holdUntil,
        manageUrl: manageUrl(tenant, booking.ref, manageToken),
      });
    } catch (err) {
      // Without a payment there is nothing holding the slot: release it.
      await sql`update bookings set status = 'cancelled', cancel_reason = 'payment_start_failed', cancelled_at = now() where id = ${booking.id}`;
      if (err instanceof PaymentStartError) throw new BookingError(`payment_${err.code}`, err.message);
      throw err;
    }
  }
  log.info('booking created', { tenant: tenant.slug, ref: booking.ref, status: booking.status, method });
  return { booking, manageToken, payment };
}

/**
 * Secret for the customer's "manage booking" link. Derived from the booking
 * id with a server key, so any later message can include the link without
 * storing the token in clear.
 */
export function manageTokenFor(bookingId: string): string {
  return Buffer.from(hmacSha256Hex(config.dataKey, `manage:${bookingId}`), 'hex').toString('base64url').slice(0, 26);
}

export function checkManageToken(bookingId: string, token: string | null): boolean {
  return !!token && safeEqual(manageTokenFor(bookingId), token);
}

export function manageUrl(tenant: Tenant, ref: string, token: string): string {
  return `${tenantBaseUrl(tenant)}/reserva/${encodeURIComponent(ref)}?t=${encodeURIComponent(token)}`;
}

export interface BookingView extends BookingRow {
  customer_name: string; customer_phone: string; customer_email: string | null;
  staff_name: string; service_name_pt: string; service_name_en: string; duration_min: number;
}

export async function bookingView(tenantId: string, by: { id?: string; ref?: string }): Promise<BookingView | null> {
  const where = by.id ? sql`b.id = ${by.id}` : sql`b.ref = ${by.ref ?? ''}`;
  const rows = await sql<BookingView[]>`
    select b.*, c.name as customer_name, c.phone as customer_phone, c.email as customer_email,
           st.name as staff_name, sv.name_pt as service_name_pt, sv.name_en as service_name_en, sv.duration_min
    from bookings b
    join customers c on c.id = b.customer_id
    join staff st on st.id = b.staff_id
    join services sv on sv.id = b.service_id
    where b.tenant_id = ${tenantId} and ${where}`;
  return rows[0] ?? null;
}

export async function paymentsForBooking(bookingId: string): Promise<PaymentRow[]> {
  return sql<PaymentRow[]>`select * from payments where booking_id = ${bookingId} order by created_at desc`;
}

export function canCustomerCancel(tenant: Tenant, b: Pick<BookingRow, 'status' | 'starts_at'>, now = new Date()): boolean {
  if (b.status !== 'confirmed' && b.status !== 'pending_payment') return false;
  return b.starts_at.getTime() - now.getTime() >= tenant.cancel_window_hours * 3_600_000;
}

export async function cancelBooking(tenantId: string, bookingId: string, reason: 'customer' | 'owner', userId: string | null = null): Promise<boolean> {
  const rows = await sql`
    update bookings set status = 'cancelled', cancel_reason = ${reason}, cancelled_at = now(), hold_expires_at = null, updated_at = now()
    where tenant_id = ${tenantId} and id = ${bookingId} and status in ('pending_payment','confirmed')
    returning id`;
  if (!rows.length) return false;
  await sql`update payments set status = 'expired', status_detail = 'booking cancelled' where booking_id = ${bookingId} and status = 'pending'`;
  await sql`insert into audit_log (tenant_id, user_id, action, details) values (${tenantId}, ${userId}, 'booking.cancelled', ${sql.json({ booking: bookingId, reason })})`;
  return true;
}

export async function setBookingStatus(tenantId: string, bookingId: string, status: 'completed' | 'no_show' | 'confirmed', userId: string): Promise<boolean> {
  const rows = await sql`
    update bookings set status = ${status}, hold_expires_at = null, updated_at = now()
    where tenant_id = ${tenantId} and id = ${bookingId} and status in ('pending_payment','confirmed','completed','no_show')
    returning id`;
  if (rows.length) await sql`insert into audit_log (tenant_id, user_id, action, details) values (${tenantId}, ${userId}, 'booking.status', ${sql.json({ booking: bookingId, status })})`;
  return rows.length > 0;
}

/** Owner records money taken in person (cash, card terminal, transfer). */
export async function recordManualPayment(tenantId: string, bookingId: string, method: 'cash' | 'card_terminal' | 'transfer', amountCents: number, userId: string): Promise<void> {
  await sql.begin(async (tx) => {
    const [b] = await tx<{ status: string }[]>`select status from bookings where tenant_id = ${tenantId} and id = ${bookingId} for update`;
    if (!b) throw new BookingError('not_found');
    await tx`insert into payments (tenant_id, booking_id, provider, method, order_id, amount_cents, status, paid_at)
             values (${tenantId}, ${bookingId}, 'manual', ${method}, ${'M' + shortCode(11)}, ${amountCents}, 'paid', now())`;
    await tx`update bookings set paid_cents = paid_cents + ${amountCents},
               status = case when status = 'pending_payment' then 'confirmed' else status end,
               hold_expires_at = case when status = 'pending_payment' then null else hold_expires_at end,
               updated_at = now()
             where id = ${bookingId}`;
    await tx`insert into audit_log (tenant_id, user_id, action, details) values (${tenantId}, ${userId}, 'payment.manual', ${tx.json({ booking: bookingId, method, amount: amountCents })})`;
  });
}

/** Releases slots whose payment window has passed. Returns released booking ids. */
export async function releaseExpiredHolds(): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    update bookings set status = 'cancelled', cancel_reason = 'hold_expired', cancelled_at = now(), updated_at = now()
    where status = 'pending_payment' and hold_expires_at < now()
    returning id`;
  if (rows.length) {
    await sql`update payments set status = 'expired', status_detail = 'hold expired'
              where status = 'pending' and booking_id in ${sql(rows.map((r) => r.id))}`;
  }
  return rows.map((r) => r.id);
}
