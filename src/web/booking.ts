// Public booking flow: the booking page, its JSON API, the payment page and
// the customer's "manage booking" page.
import { sql } from '../db.ts';
import { html, jsonForScript } from '../lib/html.ts';
import { t, tb, loc, type Locale, type MsgKey } from '../lib/i18n.ts';
import { formatDateLong, formatMoney, formatTime, isDateStr, localDateStr, addDays } from '../lib/time.ts';
import { FieldErrors, bool, email as emailField, isUuid, oneOf, phone as phoneField, str } from '../lib/validate.ts';
import { HttpError, checkSameOrigin, htmlReply, jsonReply, readBody, redirect, type Ctx, type Reply } from '../http/core.ts';
import { enforceRateLimit } from '../http/guards.ts';
import {
  BookingError, bookingView, canCustomerCancel, cancelBooking, checkManageToken, createBooking, getSlots,
  listServices, listStaff, manageTokenFor, paymentsForBooking, serviceStaffMap, type BookingView,
} from '../domain/bookings.ts';
import { amountDue, availableMethods, holdMinutesFor, startPayment, PaymentStartError, type OnlineMethod, type PaymentRow } from '../domain/payments/index.ts';
import { afterBookingCancelled, afterBookingCreated, refreshMbway } from '../domain/events.ts';
import { formatReference } from '../domain/notify.ts';
import { sitePage, whatsappLink } from './layout.ts';

const lget = (o: unknown, f: string, l: Locale) => loc(o as Record<string, unknown>, f, l);

// --- Booking page ---------------------------------------------------------
export async function bookingPage(ctx: Ctx): Promise<Reply> {
  const tenant = ctx.tenant!;
  const l = ctx.locale;
  const [services, staff, map] = await Promise.all([listServices(tenant.id), listStaff(tenant.id), serviceStaffMap(tenant.id)]);
  const today = localDateStr(new Date(), tenant.timezone);
  const data = {
    locale: l,
    tz: tenant.timezone,
    today,
    lastDay: addDays(today, tenant.max_advance_days),
    paymentMode: tenant.payment_mode,
    depositPercent: tenant.deposit_percent,
    payAtStudio: tenant.pay_at_studio_allowed,
    cancelHours: tenant.cancel_window_hours,
    whatsapp: whatsappLink(tenant.content.whatsapp),
    services: services.map((s) => ({
      id: s.id, name: lget(s, 'name', l), description: lget(s, 'description', l), category: (l === 'en' && s.category_en) || s.category,
      duration: s.duration_min, price: s.price_cents, priceLabel: formatMoney(s.price_cents, l),
      due: amountDue(tenant, s.price_cents), dueLabel: formatMoney(amountDue(tenant, s.price_cents), l),
      staff: map[s.id] ?? [],
    })),
    staff: staff.map((s) => ({ id: s.id, name: s.name, title: lget(s, 'title', l) })),
    preset: {
      service: isUuid(ctx.query.get('servico')) ? ctx.query.get('servico') : null,
      staff: isUuid(ctx.query.get('terapeuta')) ? ctx.query.get('terapeuta') : null,
      date: isDateStr(ctx.query.get('data')) ? ctx.query.get('data') : null,
      time: ctx.query.get('hora') && !Number.isNaN(Date.parse(ctx.query.get('hora')!)) ? ctx.query.get('hora') : null,
    },
    text: Object.fromEntries((Object.keys(BOOKING_STRINGS) as MsgKey[]).map((k) => [k, tb(l, tenant.business_type, k, { hours: tenant.cancel_window_hours })])),
  };

  const body = html`
<section class="book" aria-labelledby="book-title">
  <h1 id="book-title" class="book-title">${tb(l, tenant.business_type, 'book.title')}</h1>
  <noscript><p class="notice">${l === 'en' ? 'Online booking needs JavaScript. You can also book by phone or WhatsApp.' : 'A marcação online precisa de JavaScript. Também pode marcar por telefone ou WhatsApp.'} ${tenant.content.phone ?? ''}</p></noscript>
  <div id="booking-app" class="book-app" aria-live="polite"></div>
  <script type="application/json" id="booking-data">${jsonForScript(data)}</script>
</section>`;
  return htmlReply(sitePage(ctx, { title: `${tb(l, tenant.business_type, 'book.title')} | ${tenant.name}`, body, bodyClass: 'booking', scripts: ['/static/js/booking.js'], noindex: false }));
}

// Strings the browser script needs.
const BOOKING_STRINGS: Partial<Record<MsgKey, true>> = Object.fromEntries(([
  'book.step_service', 'book.step_staff', 'book.step_time', 'book.step_details', 'book.step_pay', 'book.any_staff', 'book.any_staff_hint',
  'book.no_slots', 'book.loading', 'book.change', 'book.name', 'book.phone', 'book.phone_hint', 'book.email', 'book.note', 'book.note_hint',
  'book.privacy', 'book.marketing', 'book.continue', 'book.confirm', 'book.summary', 'book.total', 'book.deposit_now', 'book.full_now',
  'book.rest_at_studio', 'book.deposit_why', 'book.pay_mbway', 'book.pay_mbway_hint', 'book.pay_multibanco', 'book.pay_multibanco_hint',
  'book.pay_card', 'book.pay_card_hint', 'book.pay_studio', 'book.pay_studio_hint', 'book.mbway_phone', 'book.policy_short',
  'book.err.slot_unavailable', 'book.err.payment_required', 'book.err.payment_method_unavailable', 'book.err.payment_invalid_phone',
  'book.err.payment_mbway_refused', 'book.err.generic', 'book.err.too_many', 'field.required', 'field.invalid', 'field.too_long', 'field.too_short',
  'services.min', 'hero.today', 'hero.tomorrow',
] as MsgKey[]).map((k) => [k, true]));

// --- JSON API ---------------------------------------------------------------
export async function apiSlots(ctx: Ctx): Promise<Reply> {
  const tenant = ctx.tenant!;
  const serviceId = ctx.query.get('service');
  const date = ctx.query.get('date');
  const staffId = ctx.query.get('staff');
  if (!isUuid(serviceId) || !isDateStr(date) || (staffId && !isUuid(staffId))) throw new HttpError(400, 'Invalid query');
  await enforceRateLimit(`slots:${ctx.ip}`, 120, 60);
  const r = await getSlots(tenant, serviceId, date, staffId || null);
  if (!r) throw new HttpError(404, 'Service not found');
  const methods = (start: Date) => availableMethods(tenant, start);
  return jsonReply({
    date,
    slots: r.slots.map((s) => ({ start: s.start.toISOString(), label: formatTime(s.start, tenant.timezone, ctx.locale), staff: s.staffIds, methods: methods(s.start) })),
  }, 200, { 'cache-control': 'no-store' });
}

/** Days in a range that have at least one slot (calendar dots). */
export async function apiDays(ctx: Ctx): Promise<Reply> {
  const tenant = ctx.tenant!;
  const serviceId = ctx.query.get('service');
  const from = ctx.query.get('from');
  const staffId = ctx.query.get('staff');
  if (!isUuid(serviceId) || !isDateStr(from) || (staffId && !isUuid(staffId))) throw new HttpError(400, 'Invalid query');
  await enforceRateLimit(`days:${ctx.ip}`, 60, 60);
  const days: string[] = [];
  const today = localDateStr(new Date(), tenant.timezone);
  const last = addDays(today, tenant.max_advance_days);
  let d = from < today ? today : from;
  for (let i = 0; i < 14 && d <= last; i++, d = addDays(d, 1)) {
    const r = await getSlots(tenant, serviceId, d, staffId || null);
    if (r && r.slots.length) days.push(d);
  }
  return jsonReply({ from, days });
}

const ERROR_KEYS: Record<string, MsgKey> = {
  slot_unavailable: 'book.err.slot_unavailable',
  payment_required: 'book.err.payment_required',
  payment_method_unavailable: 'book.err.payment_method_unavailable',
  payment_invalid_phone: 'book.err.payment_invalid_phone',
  payment_mbway_refused: 'book.err.payment_mbway_refused',
};

export async function apiCreateBooking(ctx: Ctx): Promise<Reply> {
  const tenant = ctx.tenant!;
  checkSameOrigin(ctx);
  await enforceRateLimit(`book:${ctx.ip}`, 8, 600).catch(() => { throw new HttpError(429, t(ctx.locale, 'book.err.too_many')); });
  const body = await readBody(ctx);
  // Bots fill every field; people never see this one.
  if (typeof body.website === 'string' && body.website !== '') return jsonReply({ error: 'generic', message: t(ctx.locale, 'book.err.generic') }, 400);

  const errs = new FieldErrors();
  const l = oneOf(body, 'locale', ['pt', 'en'] as const, errs, ctx.locale);
  const serviceId = typeof body.service === 'string' && isUuid(body.service) ? body.service : null;
  const staffId = typeof body.staff === 'string' && isUuid(body.staff) ? body.staff : null;
  const startStr = typeof body.start === 'string' ? body.start : '';
  const start = new Date(startStr);
  const name = str(body, 'name', errs, { min: 2, max: 80 });
  const phone = phoneField(body, 'phone', errs);
  const email = emailField(body, 'email', errs, false);
  const note = str(body, 'note', errs, { max: 600, required: false });
  if (!bool(body, 'privacy')) errs.add('privacy', 'required');
  const payment = oneOf(body, 'payment', ['mbway', 'multibanco', 'card', 'studio', 'none'] as const, errs, 'none');
  let payPhone = phone;
  if (payment === 'mbway' && typeof body.mbway_phone === 'string' && body.mbway_phone.trim()) {
    payPhone = phoneField(body, 'mbway_phone', errs);
  }
  if (!serviceId || Number.isNaN(start.getTime())) return jsonReply({ error: 'slot_unavailable', message: t(l, 'book.err.slot_unavailable') }, 400);
  if (!errs.ok) {
    return jsonReply({ error: 'fields', fields: Object.fromEntries(Object.entries(errs.errors).map(([k, v]) => [k, t(l, `field.${v}` as MsgKey)])) }, 422);
  }

  try {
    const created = await createBooking(tenant, {
      serviceId, staffId, start,
      customer: { name, phone, email, locale: l, note, marketingConsent: bool(body, 'marketing') },
      source: 'online',
      payment,
      mbwayPhone: payPhone,
    });
    afterBookingCreated(tenant.id, created);
    const token = created.manageToken;
    const ref = created.booking.ref;
    const next = created.booking.status === 'confirmed'
      ? `/reserva/${ref}?t=${token}`
      : `/reserva/${ref}/pagamento?t=${token}${created.payment ? `&payment=${created.payment.id}` : ''}`;
    return jsonReply({ ref, status: created.booking.status, next, paymentUrl: created.payment?.payment_url ?? null }, 201);
  } catch (err) {
    if (err instanceof BookingError) {
      const key = ERROR_KEYS[err.code] ?? 'book.err.generic';
      return jsonReply({ error: err.code, message: t(l, key) }, 409);
    }
    throw err;
  }
}

// --- Payment page -----------------------------------------------------------
async function bookingFromToken(ctx: Ctx): Promise<BookingView> {
  const ref = ctx.params.ref?.toUpperCase() ?? '';
  const token = ctx.query.get('t');
  if (!/^[A-Z0-9]{6}$/.test(ref)) throw new HttpError(404, t(ctx.locale, 'booking.not_found'));
  const b = await bookingView(ctx.tenant!.id, { ref });
  if (!b || !checkManageToken(b.id, token)) throw new HttpError(404, t(ctx.locale, 'booking.not_found'));
  return b;
}

function whenLabel(ctx: Ctx, b: BookingView): string {
  const tz = ctx.tenant!.timezone;
  return `${formatDateLong(b.starts_at, tz, ctx.locale)}, ${formatTime(b.starts_at, tz, ctx.locale)}`;
}

export async function paymentPage(ctx: Ctx): Promise<Reply> {
  const tenant = ctx.tenant!;
  const l = ctx.locale;
  const b = await bookingFromToken(ctx);
  if (b.status === 'confirmed' || b.status === 'completed') return redirect(`/reserva/${b.ref}?t=${encodeURIComponent(ctx.query.get('t') ?? '')}`);
  const payments = await paymentsForBooking(b.id);
  const requested = ctx.query.get('payment');
  const p = payments.find((x) => x.id === requested) ?? payments.find((x) => x.status === 'pending') ?? payments[0];
  const token = ctx.query.get('t') ?? '';
  const expired = b.status === 'cancelled';
  const methods = expired ? [] : availableMethods(tenant, b.starts_at);

  const data = {
    ref: b.ref, token, paymentId: p?.id ?? null, method: p?.method ?? null, locale: l,
    statusUrl: `/api/reserva/${b.ref}/estado?t=${encodeURIComponent(token)}`,
    payUrl: `/api/reserva/${b.ref}/pagar?t=${encodeURIComponent(token)}`,
    doneUrl: `/reserva/${b.ref}?t=${encodeURIComponent(token)}`,
    methods,
    phone: b.customer_phone,
    text: {
      failed: t(l, 'pay.mbway_failed'), waiting: t(l, 'pay.mbway_waiting'), expired: t(l, 'pay.expired'),
      retry: t(l, 'pay.retry_mbway'), other: t(l, 'pay.try_other'), mbway: t(l, 'book.pay_mbway'),
      multibanco: t(l, 'book.pay_multibanco'), card: t(l, 'book.pay_card'), generic: t(l, 'book.err.generic'),
    },
  };

  let panel;
  if (expired) {
    panel = html`<div class="pay-panel"><h1>${t(l, 'pay.expired')}</h1><p><a class="btn" href="/marcar">${t(l, 'pay.book_again')}</a></p></div>`;
  } else if (p?.method === 'multibanco' && p.mb_reference) {
    const until = p.expires_at ? `${formatDateLong(p.expires_at, tenant.timezone, l)}, ${formatTime(p.expires_at, tenant.timezone, l)}` : '';
    panel = html`<div class="pay-panel" data-state="multibanco">
      <h1>${t(l, 'pay.mb_title')}</h1>
      <dl class="mb-ref">
        <div><dt>${t(l, 'pay.entity')}</dt><dd>${p.mb_entity}</dd></div>
        <div><dt>${t(l, 'pay.reference')}</dt><dd>${formatReference(p.mb_reference)}</dd></div>
        <div><dt>${t(l, 'pay.amount')}</dt><dd>${formatMoney(p.amount_cents, l)}</dd></div>
      </dl>
      <p>${t(l, 'pay.mb_body', { until })}</p>
    </div>`;
  } else if (p?.method === 'card') {
    panel = html`<div class="pay-panel" data-state="card">
      <h1>${t(l, 'pay.card_title')}</h1>
      <p>${t(l, 'pay.card_body')}</p>
      <div class="spinner" aria-hidden="true"></div>
    </div>`;
  } else {
    panel = html`<div class="pay-panel" data-state="mbway">
      <h1>${t(l, 'pay.mbway_title')}</h1>
      <p>${p ? t(l, 'pay.mbway_body', { amount: formatMoney(p.amount_cents, l), phone: p.phone ?? b.customer_phone }) : ''}</p>
      <p class="pay-status" id="pay-status"><span class="spinner" aria-hidden="true"></span> ${t(l, 'pay.mbway_waiting')}</p>
    </div>`;
  }

  const body = html`<section class="section pay" aria-live="polite">
    ${panel}
    <div id="pay-actions" class="pay-actions"></div>
    <aside class="pay-summary">
      <p><strong>${lget({ name_pt: b.service_name_pt, name_en: b.service_name_en }, 'name', l)}</strong></p>
      <p>${whenLabel(ctx, b)}</p>
      <p>${t(l, 'booking.with')} ${b.staff_name}</p>
      <p class="muted">${t(l, 'booking.ref')} ${b.ref}</p>
    </aside>
    <script type="application/json" id="pay-data">${jsonForScript(data)}</script>
  </section>`;
  return htmlReply(sitePage(ctx, { title: `${t(l, 'book.step_pay')} | ${tenant.name}`, body, scripts: ['/static/js/payment.js'], noindex: true }));
}

/** Polled by the payment page. Also nudges the gateway for MB WAY status. */
export async function apiBookingStatus(ctx: Ctx): Promise<Reply> {
  const tenant = ctx.tenant!;
  const b = await bookingFromToken(ctx);
  await enforceRateLimit(`status:${ctx.ip}`, 120, 60);
  let payments = await paymentsForBooking(b.id);
  const pending = payments.find((p) => p.status === 'pending' && p.method === 'mbway');
  if (pending && b.status === 'pending_payment') {
    const last = pending.last_checked_at ? new Date(pending.last_checked_at).getTime() : 0;
    if (Date.now() - last > 4000) {
      try { await refreshMbway(tenant, pending); } catch { /* the callback or worker will catch up */ }
      payments = await paymentsForBooking(b.id);
    }
  }
  const fresh = await bookingView(tenant.id, { id: b.id });
  const latest = payments[0];
  return jsonReply({
    booking: fresh?.status ?? b.status,
    payment: latest ? { id: latest.id, method: latest.method, status: latest.status } : null,
    holdExpiresAt: fresh?.hold_expires_at ?? null,
  });
}

/** Start another payment attempt for a booking still waiting to be paid. */
export async function apiRetryPayment(ctx: Ctx): Promise<Reply> {
  const tenant = ctx.tenant!;
  checkSameOrigin(ctx);
  const b = await bookingFromToken(ctx);
  await enforceRateLimit(`retry:${b.id}`, 5, 600).catch(() => { throw new HttpError(429, t(ctx.locale, 'book.err.too_many')); });
  if (b.status !== 'pending_payment') return jsonReply({ error: 'not_pending', message: t(ctx.locale, 'pay.expired') }, 409);
  const body = await readBody(ctx);
  const errs = new FieldErrors();
  const method = oneOf(body, 'method', ['mbway', 'multibanco', 'card'] as const, errs) as OnlineMethod;
  let phone = b.customer_phone;
  if (method === 'mbway' && typeof body.phone === 'string' && body.phone.trim()) phone = phoneField(body, 'phone', errs);
  if (!errs.ok) return jsonReply({ error: 'fields', message: t(ctx.locale, 'field.invalid') }, 422);
  if (!availableMethods(tenant, b.starts_at).includes(method)) {
    return jsonReply({ error: 'payment_method_unavailable', message: t(ctx.locale, 'book.err.payment_method_unavailable') }, 409);
  }

  // Extend the hold so the new attempt has its full time window.
  const holdUntil = new Date(Date.now() + holdMinutesFor(tenant, method) * 60_000);
  const extended = await sql`update bookings set hold_expires_at = greatest(hold_expires_at, ${holdUntil}), updated_at = now()
                             where id = ${b.id} and status = 'pending_payment' returning id`;
  if (!extended.length) return jsonReply({ error: 'not_pending', message: t(ctx.locale, 'pay.expired') }, 409);
  await sql`update payments set status = 'failed', status_detail = 'superseded' where booking_id = ${b.id} and status = 'pending'`;

  const token = manageTokenFor(b.id);
  try {
    const p = await startPayment({
      tenant, bookingId: b.id, bookingRef: b.ref, method, amountCents: b.amount_due_cents - b.paid_cents > 0 ? b.amount_due_cents - b.paid_cents : b.amount_due_cents,
      phone, email: b.customer_email, locale: b.locale, holdUntil, manageUrl: '',
    });
    return jsonReply({ next: `/reserva/${b.ref}/pagamento?t=${token}&payment=${p.id}`, paymentUrl: p.payment_url ?? null }, 201);
  } catch (err) {
    if (err instanceof PaymentStartError) {
      const key = ERROR_KEYS[`payment_${err.code}`] ?? 'book.err.generic';
      return jsonReply({ error: err.code, message: t(ctx.locale, key) }, 409);
    }
    throw err;
  }
}

// --- Manage booking page --------------------------------------------------
export async function manageBookingPage(ctx: Ctx): Promise<Reply> {
  const tenant = ctx.tenant!;
  const l = ctx.locale;
  const b = await bookingFromToken(ctx);
  if (b.status === 'pending_payment') return redirect(`/reserva/${b.ref}/pagamento?t=${encodeURIComponent(ctx.query.get('t') ?? '')}`);
  const token = ctx.query.get('t') ?? '';
  const c = tenant.content;
  const titleKey: MsgKey = b.status === 'confirmed' ? 'booking.confirmed_title' : b.status === 'cancelled' ? 'booking.cancelled_title' : 'booking.completed_title';
  const canCancel = canCustomerCancel(tenant, b);
  const remaining = Math.max(0, b.price_cents - b.paid_cents);
  const wa = whatsappLink(c.whatsapp, `${l === 'en' ? 'Hello, about my booking' : 'Olá, sobre a minha marcação'} ${b.ref}`);
  const justCancelled = ctx.query.get('cancelado') === '1';

  const body = html`<section class="section ticket-wrap">
    <article class="ticket" data-status="${b.status}">
      <h1>${justCancelled ? t(l, 'booking.cancelled_ok') : t(l, titleKey)}</h1>
      <dl class="ticket-facts">
        <div><dt>${t(l, 'book.step_service')}</dt><dd>${lget({ name_pt: b.service_name_pt, name_en: b.service_name_en }, 'name', l)}, ${b.duration_min} ${t(l, 'services.min')}</dd></div>
        <div><dt>${t(l, 'booking.when')}</dt><dd>${whenLabel(ctx, b)}</dd></div>
        <div><dt>${t(l, 'booking.with')}</dt><dd>${b.staff_name}</dd></div>
        ${c.address ? html`<div><dt>${t(l, 'booking.where')}</dt><dd>${tenant.name}, ${c.address}</dd></div>` : ''}
        ${b.paid_cents > 0 ? html`<div><dt>${t(l, 'booking.paid')}</dt><dd>${formatMoney(b.paid_cents, l)}</dd></div>` : ''}
        ${b.status === 'confirmed' && remaining > 0 ? html`<div><dt>${t(l, 'booking.due_on_day')}</dt><dd>${formatMoney(remaining, l)}</dd></div>` : ''}
        <div><dt>${t(l, 'booking.ref')}</dt><dd class="ticket-ref">${b.ref}</dd></div>
      </dl>
      ${b.status === 'confirmed' ? html`<div class="ticket-actions">
        <a class="btn" href="/reserva/${b.ref}/calendario.ics?t=${token}">${t(l, 'booking.add_calendar')}</a>
        ${canCancel
          ? html`<form method="post" action="/reserva/${b.ref}/cancelar?t=${token}" class="cancel-form" data-confirm="${t(l, 'booking.cancel_confirm')}">
              <button class="btn btn-quiet" type="submit">${t(l, 'booking.cancel')}</button></form>`
          : html`<p class="muted">${t(l, 'booking.cancel_too_late', { hours: tenant.cancel_window_hours })}</p>`}
      </div>` : ''}
      ${b.status === 'cancelled' ? html`<p><a class="btn" href="/marcar">${t(l, 'pay.book_again')}</a></p>` : ''}
    </article>
    <p class="ticket-contact">${t(l, 'booking.contact')}: ${c.phone ? html`<a href="tel:${c.phone.replace(/\s/g, '')}">${c.phone}</a>` : ''} ${wa ? html`<a href="${wa}" rel="noopener" target="_blank">WhatsApp</a>` : ''}</p>
  </section>`;
  return htmlReply(sitePage(ctx, { title: `${b.ref} | ${tenant.name}`, body, scripts: ['/static/js/manage.js'], noindex: true }));
}

export async function cancelByCustomer(ctx: Ctx): Promise<Reply> {
  const tenant = ctx.tenant!;
  checkSameOrigin(ctx);
  const b = await bookingFromToken(ctx);
  const token = ctx.query.get('t') ?? '';
  if (!canCustomerCancel(tenant, b)) return redirect(`/reserva/${b.ref}?t=${encodeURIComponent(token)}`);
  if (await cancelBooking(tenant.id, b.id, 'customer')) afterBookingCancelled(tenant.id, b.id, 'customer');
  return redirect(`/reserva/${b.ref}?t=${encodeURIComponent(token)}&cancelado=1`);
}

/** .ics file so the customer can add the appointment to any calendar app. */
export async function bookingIcs(ctx: Ctx): Promise<Reply> {
  const tenant = ctx.tenant!;
  const b = await bookingFromToken(ctx);
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s: string) => s.replace(/[\\;,]/g, (m) => `\\${m}`).replace(/\n/g, '\\n');
  const title = `${lget({ name_pt: b.service_name_pt, name_en: b.service_name_en }, 'name', b.locale)} | ${tenant.name}`;
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Reservo//PT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${b.id}@reservo`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(b.starts_at)}`,
    `DTEND:${stamp(b.ends_at)}`,
    `SUMMARY:${esc(title)}`,
    `LOCATION:${esc([tenant.content.address, tenant.content.city].filter(Boolean).join(', '))}`,
    `DESCRIPTION:${esc(`${b.staff_name}. ${b.ref}`)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', `DESCRIPTION:${esc(title)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  return { status: 200, headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="${b.ref}.ics"`, 'cache-control': 'no-store' }, body: ics };
}

export type { PaymentRow };
