import { sql } from '../../db.ts';
import { html, raw, type SafeHtml } from '../../lib/html.ts';
import { loc, tb, type Locale } from '../../lib/i18n.ts';
import { addDays, formatDateLong, formatMoney, formatTime, hhmmToMinutes, isDateStr, localDateStr, minutesToHHMM, toLocalParts, zonedToUtc } from '../../lib/time.ts';
import { FieldErrors, bool, email as emailField, euros, isUuid, oneOf, phone as phoneField, str, uuid } from '../../lib/validate.ts';
import { HttpError, htmlReply, jsonReply, readBody, redirect, type Ctx, type Reply } from '../../http/core.ts';
import {
  BookingError, bookingView, cancelBooking, createBooking, getSlots, listServices, listStaff, manageTokenFor, manageUrl,
  paymentsForBooking, recordManualPayment, setBookingStatus, type BookingView,
} from '../../domain/bookings.ts';
import { availableMethods } from '../../domain/payments/index.ts';
import { afterBookingCancelled, afterBookingCreated } from '../../domain/events.ts';
import { notifyConfirmed, formatReference } from '../../domain/notify.ts';
import { whatsappLink } from '../layout.ts';
import { adminPage, csrfField, fieldError, flashFrom, staffWord, tr } from './layout.ts';
import { studioHours } from '../site.ts';

const STATUS: Record<string, [string, string]> = {
  pending_payment: ['A aguardar pagamento', 'Awaiting payment'],
  confirmed: ['Confirmada', 'Confirmed'],
  cancelled: ['Cancelada', 'Cancelled'],
  completed: ['Concluída', 'Completed'],
  no_show: ['Faltou', 'No-show'],
};
const METHOD: Record<string, [string, string]> = {
  mbway: ['MB WAY', 'MB WAY'], multibanco: ['Multibanco', 'Multibanco'], card: ['Cartão online', 'Card online'],
  cash: ['Numerário', 'Cash'], card_terminal: ['Terminal (TPA)', 'Card terminal'], transfer: ['Transferência', 'Bank transfer'],
};
const PSTATUS: Record<string, [string, string]> = {
  pending: ['Pendente', 'Pending'], paid: ['Pago', 'Paid'], failed: ['Falhou', 'Failed'], expired: ['Expirou', 'Expired'], refunded: ['Devolvido', 'Refunded'],
};

function statusBadge(status: string, l: Locale): SafeHtml {
  const s = STATUS[status] ?? [status, status];
  return html`<span class="badge badge-${status}">${tr(l, s[0], s[1])}</span>`;
}

function serviceName(b: { service_name_pt: string; service_name_en: string }, l: Locale): string {
  return loc({ name_pt: b.service_name_pt, name_en: b.service_name_en }, 'name', l);
}

// --- Agenda (day view) -----------------------------------------------------
export async function agenda(ctx: Ctx): Promise<Reply> {
  const tenant = ctx.tenant!;
  const l = ctx.locale;
  const tz = tenant.timezone;
  const today = localDateStr(new Date(), tz);
  const date = isDateStr(ctx.query.get('date')) ? ctx.query.get('date')! : today;
  const from = zonedToUtc(date, 0, tz), to = zonedToUtc(date, 1440, tz);
  const [staff, rows, hours] = await Promise.all([
    listStaff(tenant.id),
    sql<BookingView[]>`
      select b.*, c.name as customer_name, c.phone as customer_phone, c.email as customer_email, st.name as staff_name,
             sv.name_pt as service_name_pt, sv.name_en as service_name_en, sv.duration_min
      from bookings b join customers c on c.id = b.customer_id join staff st on st.id = b.staff_id join services sv on sv.id = b.service_id
      where b.tenant_id = ${tenant.id} and b.starts_at >= ${from} and b.starts_at < ${to}
        and b.status in ('pending_payment','confirmed','completed','no_show')
      order by b.starts_at`,
    studioHours(tenant.id),
  ]);

  // Visible range: studio hours for the day, stretched to fit any booking.
  const wd = new Date(Date.UTC(...(date.split('-').map(Number) as [number, number, number]))).getUTCDay();
  const h = hours.get(wd) ?? { start: 9 * 60, end: 20 * 60 };
  let startMin = Math.floor(h.start / 60) * 60, endMin = Math.ceil(h.end / 60) * 60;
  const minuteOf = (d: Date) => { const p = toLocalParts(d, tz); return p.hour * 60 + p.minute; };
  for (const b of rows) {
    startMin = Math.min(startMin, Math.floor(minuteOf(b.starts_at) / 60) * 60);
    endMin = Math.max(endMin, Math.ceil((minuteOf(b.starts_at) + b.duration_min) / 60) * 60);
  }
  const span = Math.max(60, endMin - startMin);
  const pxPerMin = 1.4;

  // Positions go in a nonce'd style block, since the CSP forbids inline style attributes.
  const rules: string[] = [`.agenda-col .agenda-track{height:${Math.round(span * pxPerMin)}px}`];
  rows.forEach((b, i) => {
    rules.push(`#ag-${i}{top:${Math.round((minuteOf(b.starts_at) - startMin) * pxPerMin)}px;height:${Math.max(28, Math.round(b.duration_min * pxPerMin) - 2)}px}`);
  });
  const hourMarks: SafeHtml[] = [];
  for (let m = startMin; m <= endMin; m += 60) {
    const i = hourMarks.length;
    rules.push(`#hr-${i}{top:${Math.round((m - startMin) * pxPerMin)}px}`);
    hourMarks.push(html`<span class="agenda-hour" id="hr-${i}">${minutesToHHMM(m)}</span>`);
  }

  const dayTotal = rows.filter((b) => b.status !== 'no_show').reduce((s, b) => s + b.price_cents, 0);
  const body = html`
<header class="adm-head">
  <h1>${formatDateLong(from, tz, l)}</h1>
  <form class="day-nav" method="get" action="/admin">
    <a class="btn btn-quiet btn-small" href="/admin?date=${addDays(date, -1)}" aria-label="${tr(l, 'Dia anterior', 'Previous day')}">‹</a>
    <input type="date" name="date" value="${date}" aria-label="${tr(l, 'Escolher dia', 'Pick a day')}" class="js-autosubmit">
    <a class="btn btn-quiet btn-small" href="/admin?date=${addDays(date, 1)}" aria-label="${tr(l, 'Dia seguinte', 'Next day')}">›</a>
    ${date !== today ? html`<a class="btn btn-quiet btn-small" href="/admin">${tr(l, 'Hoje', 'Today')}</a>` : ''}
  </form>
  <a class="btn" href="/admin/bookings/new?date=${date}">${tr(l, 'Nova marcação', 'New booking')}</a>
</header>
<p class="muted">${rows.length} ${tr(l, rows.length === 1 ? 'marcação' : 'marcações', rows.length === 1 ? 'booking' : 'bookings')}, ${formatMoney(dayTotal, l)}</p>
${raw(`<style nonce="${ctx.nonce}">${rules.join('')}</style>`)}
${staff.length ? html`<div class="agenda">
  <div class="agenda-hours" aria-hidden="true"><div class="agenda-track">${hourMarks}</div></div>
  ${staff.map((s) => html`<section class="agenda-col" aria-label="${s.name}">
    <h2>${s.name}</h2>
    <div class="agenda-track">
      ${rows.map((b, i) => b.staff_id !== s.id ? '' : html`<a class="agenda-item status-${b.status}" id="ag-${i}" href="/admin/bookings/${b.id}">
        <span class="agenda-time">${formatTime(b.starts_at, tz, l)}–${formatTime(b.ends_at, tz, l)}</span>
        <span class="agenda-who">${b.customer_name}</span>
        <span class="agenda-what">${serviceName(b, l)}</span>
        ${b.status !== 'confirmed' ? statusBadge(b.status, l) : ''}
      </a>`)}
    </div>
  </section>`)}
</div>` : html`<p class="empty">${tr(l, 'Adicione a equipa e o horário de trabalho para começar a receber marcações.', 'Add your team and their working hours to start taking bookings.')} <a href="/admin/team/new">${tr(l, 'Adicionar', 'Add')} ${staffWord(ctx).toLowerCase()}</a></p>`}`;
  return htmlReply(adminPage(ctx, { title: tr(l, 'Agenda', 'Agenda'), body, flash: flashFrom(ctx) }));
}

// --- Booking list ------------------------------------------------------------
export async function bookingList(ctx: Ctx): Promise<Reply> {
  const tenant = ctx.tenant!;
  const l = ctx.locale;
  const tz = tenant.timezone;
  const view = oneOf({ v: ctx.query.get('v') ?? '' }, 'v', ['upcoming', 'pending', 'past', 'cancelled'] as const, new FieldErrors(), 'upcoming');
  const q = (ctx.query.get('q') ?? '').trim().slice(0, 60);
  const filter = {
    upcoming: sql`b.starts_at >= now() and b.status = 'confirmed'`,
    pending: sql`b.status = 'pending_payment'`,
    past: sql`b.starts_at < now() and b.status in ('confirmed','completed','no_show')`,
    cancelled: sql`b.status = 'cancelled'`,
  }[view];
  const search = q ? sql`and (c.name ilike ${'%' + q.replace(/[%_\\]/g, '\\$&') + '%'} or c.phone like ${'%' + q.replace(/\D/g, '') + '%'} or b.ref = ${q.toUpperCase()})` : sql``;
  const order = view === 'upcoming' || view === 'pending' ? sql`b.starts_at asc` : sql`b.starts_at desc`;
  const rows = await sql<BookingView[]>`
    select b.*, c.name as customer_name, c.phone as customer_phone, c.email as customer_email, st.name as staff_name,
           sv.name_pt as service_name_pt, sv.name_en as service_name_en, sv.duration_min
    from bookings b join customers c on c.id = b.customer_id join staff st on st.id = b.staff_id join services sv on sv.id = b.service_id
    where b.tenant_id = ${tenant.id} and ${filter} ${search}
    order by ${order} limit 200`;

  const tabs: [typeof view, string, string][] = [
    ['upcoming', 'Próximas', 'Upcoming'], ['pending', 'A aguardar pagamento', 'Awaiting payment'],
    ['past', 'Passadas', 'Past'], ['cancelled', 'Canceladas', 'Cancelled'],
  ];
  const body = html`
<header class="adm-head"><h1>${tr(l, 'Marcações', 'Bookings')}</h1>
  <a class="btn" href="/admin/bookings/new">${tr(l, 'Nova marcação', 'New booking')}</a></header>
<nav class="tabs" aria-label="${tr(l, 'Filtro', 'Filter')}">
  ${tabs.map(([k, pt, en]) => html`<a href="/admin/bookings?v=${k}" ${view === k ? html`aria-current="page"` : ''}>${tr(l, pt, en)}</a>`)}
</nav>
<form class="search" method="get" action="/admin/bookings">
  <input type="hidden" name="v" value="${view}">
  <input type="search" name="q" value="${q}" placeholder="${tr(l, 'Nome, telemóvel ou código', 'Name, phone or code')}" aria-label="${tr(l, 'Procurar', 'Search')}">
  <button class="btn btn-quiet" type="submit">${tr(l, 'Procurar', 'Search')}</button>
</form>
${rows.length ? html`<table class="table">
  <thead><tr><th>${tr(l, 'Quando', 'When')}</th><th>${tr(l, 'Cliente', 'Customer')}</th><th>${tb(l, ctx.tenant!.business_type, 'book.step_service')}</th><th>${staffWord(ctx)}</th><th>${tr(l, 'Estado', 'Status')}</th></tr></thead>
  <tbody>${rows.map((b) => html`<tr>
    <td><a href="/admin/bookings/${b.id}">${formatDateLong(b.starts_at, tz, l)}, ${formatTime(b.starts_at, tz, l)}</a></td>
    <td>${b.customer_name}<br><span class="muted">${b.customer_phone}</span></td>
    <td>${serviceName(b, l)}</td><td>${b.staff_name}</td><td>${statusBadge(b.status, l)}</td></tr>`)}
  </tbody></table>` : html`<p class="empty">${q ? tr(l, 'Nenhuma marcação encontrada.', 'No bookings found.') : tr(l, 'Ainda não há marcações aqui.', 'No bookings here yet.')}</p>`}`;
  return htmlReply(adminPage(ctx, { title: tr(l, 'Marcações', 'Bookings'), body, flash: flashFrom(ctx) }));
}

// --- Booking detail -------------------------------------------------------------
export async function bookingDetail(ctx: Ctx): Promise<Reply> {
  const tenant = ctx.tenant!;
  const l = ctx.locale;
  const tz = tenant.timezone;
  if (!isUuid(ctx.params.id)) throw new HttpError(404, 'Not found');
  const b = await bookingView(tenant.id, { id: ctx.params.id });
  if (!b) throw new HttpError(404, tr(l, 'Marcação não encontrada.', 'Booking not found.'));
  const payments = await paymentsForBooking(b.id);
  const remaining = Math.max(0, b.price_cents - b.paid_cents);
  const when = `${formatDateLong(b.starts_at, tz, b.locale)}, ${formatTime(b.starts_at, tz, b.locale)}`;
  const link = manageUrl(tenant, b.ref, manageTokenFor(b.id));
  const waText = b.locale === 'en'
    ? `Hi ${b.customer_name.split(' ')[0]}, this is ${tenant.name} about your ${serviceName(b, 'en')} on ${when}. `
    : `Olá ${b.customer_name.split(' ')[0]}, fala o ${tenant.name} sobre a sua marcação de ${serviceName(b, 'pt')} em ${when}. `;
  const active = b.status === 'confirmed' || b.status === 'pending_payment';

  const body = html`
<header class="adm-head"><h1>${b.customer_name}</h1>${statusBadge(b.status, l)}</header>
<div class="detail-grid">
  <section class="panel">
    <dl class="facts">
      <div><dt>${tr(l, 'Quando', 'When')}</dt><dd>${formatDateLong(b.starts_at, tz, l)}, ${formatTime(b.starts_at, tz, l)}–${formatTime(b.ends_at, tz, l)}</dd></div>
      <div><dt>${tr(l, 'Tratamento', 'Treatment')}</dt><dd>${serviceName(b, l)}, ${b.duration_min} min</dd></div>
      <div><dt>${staffWord(ctx)}</dt><dd>${b.staff_name}</dd></div>
      <div><dt>${tr(l, 'Telemóvel', 'Phone')}</dt><dd><a href="tel:${b.customer_phone}">${b.customer_phone}</a></dd></div>
      ${b.customer_email ? html`<div><dt>Email</dt><dd><a href="mailto:${b.customer_email}">${b.customer_email}</a></dd></div>` : ''}
      ${b.customer_note ? html`<div><dt>${tr(l, 'Nota do cliente', 'Customer note')}</dt><dd>${b.customer_note}</dd></div>` : ''}
      <div><dt>${tr(l, 'Preço', 'Price')}</dt><dd>${formatMoney(b.price_cents, l)}</dd></div>
      <div><dt>${tr(l, 'Pago', 'Paid')}</dt><dd>${formatMoney(b.paid_cents, l)}${remaining > 0 && b.status !== 'cancelled' ? html` <span class="muted">(${tr(l, 'falta', 'remaining')} ${formatMoney(remaining, l)})</span>` : ''}</dd></div>
      <div><dt>${tr(l, 'Código', 'Code')}</dt><dd>${b.ref}, ${b.source === 'online' ? tr(l, 'marcada online', 'booked online') : tr(l, 'marcada pela equipa', 'booked by staff')}</dd></div>
      ${b.cancel_reason === 'paid_after_slot_taken' ? html`<div class="warn"><dt>${tr(l, 'Atenção', 'Action needed')}</dt><dd>${tr(l, 'O cliente pagou depois do prazo e o horário já estava ocupado. Contacte-o para remarcar ou devolver o dinheiro no backoffice da ifthenpay.', 'The customer paid after the deadline and the slot was already taken. Contact them to rebook, or refund in the ifthenpay back office.')}</dd></div>` : ''}
    </dl>
    <p class="actions-row">
      <a class="btn btn-quiet" href="${whatsappLink(b.customer_phone, waText)}" target="_blank" rel="noopener">WhatsApp</a>
      <a class="btn btn-quiet" href="${link}" target="_blank" rel="noopener">${tr(l, 'Página do cliente', 'Customer page')}</a>
    </p>
  </section>

  <section class="panel">
    <h2>${tr(l, 'Ações', 'Actions')}</h2>
    ${active ? html`
    ${remaining > 0 ? html`<form method="post" action="/admin/bookings/${b.id}/pay" class="form form-inline">${csrfField(ctx)}
      <label>${tr(l, 'Registar pagamento', 'Record payment')}
        <select name="method">
          <option value="cash">${tr(l, 'Numerário', 'Cash')}</option>
          <option value="card_terminal">${tr(l, 'Terminal (TPA)', 'Card terminal')}</option>
          <option value="transfer">${tr(l, 'Transferência / MB WAY direto', 'Transfer / direct MB WAY')}</option>
        </select></label>
      <label>${tr(l, 'Valor (€)', 'Amount (€)')}<input name="amount" inputmode="decimal" value="${(remaining / 100).toFixed(2).replace('.', l === 'pt' ? ',' : '.')}" required></label>
      <button class="btn" type="submit">${tr(l, 'Registar', 'Record')}</button>
    </form>` : ''}
    <div class="actions-row">
      ${b.status === 'pending_payment' ? actionButton(ctx, b.id, 'confirm', tr(l, 'Confirmar sem pagamento', 'Confirm without payment')) : ''}
      ${b.status === 'confirmed' && b.starts_at.getTime() < Date.now() ? actionButton(ctx, b.id, 'complete', tr(l, 'Marcar como concluída', 'Mark completed')) : ''}
      ${b.status === 'confirmed' && b.starts_at.getTime() < Date.now() ? actionButton(ctx, b.id, 'no_show', tr(l, 'Faltou', 'No-show')) : ''}
      ${b.status === 'confirmed' ? actionButton(ctx, b.id, 'resend', tr(l, 'Reenviar confirmação', 'Resend confirmation')) : ''}
    </div>
    <form method="post" action="/admin/bookings/${b.id}/action" class="danger-zone" data-confirm="${tr(l, 'Cancelar esta marcação e avisar o cliente?', 'Cancel this booking and tell the customer?')}">${csrfField(ctx)}
      <input type="hidden" name="action" value="cancel">
      <button class="btn btn-danger" type="submit">${tr(l, 'Cancelar marcação', 'Cancel booking')}</button>
      ${b.paid_cents > 0 ? html`<p class="muted">${tr(l, 'Devoluções de MB WAY ou cartão fazem-se no backoffice da ifthenpay.', 'Refunds for MB WAY or card are made in the ifthenpay back office.')}</p>` : ''}
    </form>` : html`<p class="muted">${tr(l, 'Sem ações disponíveis.', 'No actions available.')}</p>`}
  </section>

  <section class="panel">
    <h2>${tr(l, 'Pagamentos', 'Payments')}</h2>
    ${payments.length ? html`<ul class="plain">${payments.map((p) => html`<li>
      <strong>${tr(l, (METHOD[p.method] ?? [p.method, p.method])[0], (METHOD[p.method] ?? [p.method, p.method])[1])}</strong>,
      ${formatMoney(p.amount_cents, l)}, ${tr(l, (PSTATUS[p.status] ?? [p.status, p.status])[0], (PSTATUS[p.status] ?? [p.status, p.status])[1])}
      ${p.mb_reference ? html`<br><span class="muted">${tr(l, 'Entidade', 'Entity')} ${p.mb_entity}, ${tr(l, 'ref.', 'ref.')} ${formatReference(p.mb_reference)}</span>` : ''}
      ${p.provider === 'mock' && p.status === 'pending' && p.method === 'multibanco' ? html`<button class="btn btn-small btn-quiet js-mock-pay" data-url="/pay/mock-multibanco/${p.id}" type="button">${tr(l, 'Simular pagamento', 'Simulate payment')}</button>` : ''}
    </li>`)}</ul>` : html`<p class="muted">${tr(l, 'Ainda sem pagamentos.', 'No payments yet.')}</p>`}
  </section>
</div>`;
  return htmlReply(adminPage(ctx, { title: b.customer_name, body, flash: flashFrom(ctx) }));
}

function actionButton(ctx: Ctx, id: string, action: string, label: string): SafeHtml {
  return html`<form method="post" action="/admin/bookings/${id}/action">${csrfField(ctx)}<input type="hidden" name="action" value="${action}"><button class="btn btn-quiet" type="submit">${label}</button></form>`;
}

export async function bookingAction(ctx: Ctx): Promise<Reply> {
  const tenant = ctx.tenant!;
  if (!isUuid(ctx.params.id)) throw new HttpError(404, 'Not found');
  const body = await readBody(ctx);
  const id = ctx.params.id;
  const userId = ctx.session!.userId;
  switch (body.action) {
    case 'cancel':
      if (await cancelBooking(tenant.id, id, 'owner', userId)) afterBookingCancelled(tenant.id, id, 'owner');
      return redirect(`/admin/bookings/${id}?ok=cancelled`);
    case 'complete': await setBookingStatus(tenant.id, id, 'completed', userId); break;
    case 'no_show': await setBookingStatus(tenant.id, id, 'no_show', userId); break;
    case 'confirm': await setBookingStatus(tenant.id, id, 'confirmed', userId); await notifyConfirmed(tenant.id, id); break;
    case 'resend': await notifyConfirmed(tenant.id, id); return redirect(`/admin/bookings/${id}?ok=sent`);
    default: throw new HttpError(400, 'Unknown action');
  }
  return redirect(`/admin/bookings/${id}?ok=updated`);
}

export async function bookingPay(ctx: Ctx): Promise<Reply> {
  const tenant = ctx.tenant!;
  if (!isUuid(ctx.params.id)) throw new HttpError(404, 'Not found');
  const body = await readBody(ctx);
  const errs = new FieldErrors();
  const method = oneOf(body, 'method', ['cash', 'card_terminal', 'transfer'] as const, errs);
  const cents = euros(body, 'amount', errs);
  if (!errs.ok || cents <= 0) throw new HttpError(422, tr(ctx.locale, 'Valor inválido.', 'Invalid amount.'));
  await recordManualPayment(tenant.id, ctx.params.id, method, cents, ctx.session!.userId);
  return redirect(`/admin/bookings/${ctx.params.id}?ok=paid`);
}

// --- New booking (phone / WhatsApp / walk-in) ----------------------------------
export async function newBookingForm(ctx: Ctx, errors: Record<string, string> = {}, values: Record<string, unknown> = {}, message = ''): Promise<Reply> {
  const tenant = ctx.tenant!;
  const l = ctx.locale;
  const [services, staff] = await Promise.all([listServices(tenant.id), listStaff(tenant.id)]);
  const v = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : '');
  const date = v('date') || (isDateStr(ctx.query.get('date')) ? ctx.query.get('date')! : localDateStr(new Date(), tenant.timezone));
  const methods = availableMethods(tenant, new Date(Date.now() + 7 * 86_400_000));

  const body = html`
<h1>${tr(l, 'Nova marcação', 'New booking')}</h1>
<p class="muted">${tr(l, 'Para marcações por telefone, WhatsApp ou ao balcão. Fica na mesma agenda que as marcações online.', 'For bookings by phone, WhatsApp or in person. They go in the same calendar as online bookings.')}</p>
${message ? html`<p class="flash flash-error" role="alert">${message}</p>` : ''}
<form method="post" action="/admin/bookings/new" class="form js-new-booking">${csrfField(ctx)}
  <fieldset><legend>${tr(l, 'Marcação', 'Appointment')}</legend>
    <label>${tr(l, 'Tratamento', 'Treatment')}
      <select name="service" required class="js-slot-input">
        ${services.map((s) => html`<option value="${s.id}" ${v('service') === s.id ? 'selected' : ''}>${loc(s as unknown as Record<string, unknown>, 'name', l)} (${s.duration_min} min, ${formatMoney(s.price_cents, l)})</option>`)}
      </select>${fieldError(errors, 'service', l)}</label>
    <label>${staffWord(ctx)}
      <select name="staff" class="js-slot-input">
        <option value="">${tr(l, 'Quem estiver livre', 'Whoever is free')}</option>
        ${staff.map((s) => html`<option value="${s.id}" ${v('staff') === s.id ? 'selected' : ''}>${s.name}</option>`)}
      </select></label>
    <div class="row">
      <label>${tr(l, 'Dia', 'Day')}<input type="date" name="date" value="${date}" required class="js-slot-input">${fieldError(errors, 'date', l)}</label>
      <label>${tr(l, 'Hora', 'Time')}<input type="time" name="time" value="${v('time')}" required step="300">${fieldError(errors, 'time', l)}</label>
    </div>
    <div class="slot-suggest" aria-live="polite" data-empty="${tr(l, 'Sem horários livres neste dia.', 'No free times this day.')}" data-label="${tr(l, 'Horários livres:', 'Free times:')}"></div>
    <label class="check"><input type="checkbox" name="override" ${values.override ? 'checked' : ''}> ${tr(l, 'Permitir fora do horário de trabalho', 'Allow outside working hours')}</label>
  </fieldset>
  <fieldset><legend>${tr(l, 'Cliente', 'Customer')}</legend>
    <label>${tr(l, 'Nome', 'Name')}<input name="name" value="${v('name')}" required maxlength="80">${fieldError(errors, 'name', l)}</label>
    <label>${tr(l, 'Telemóvel', 'Phone')}<input name="phone" type="tel" value="${v('phone')}" required>${fieldError(errors, 'phone', l)}</label>
    <label>Email<input name="email" type="email" value="${v('email')}">${fieldError(errors, 'email', l)}</label>
    <label>${tr(l, 'Nota', 'Note')}<textarea name="note" rows="2" maxlength="600">${v('note')}</textarea></label>
    <label>${tr(l, 'Idioma das mensagens', 'Message language')}<select name="locale"><option value="pt">Português</option><option value="en" ${v('locale') === 'en' ? 'selected' : ''}>English</option></select></label>
  </fieldset>
  <fieldset><legend>${tr(l, 'Pagamento', 'Payment')}</legend>
    <label class="check"><input type="radio" name="payment" value="studio" ${!v('payment') || v('payment') === 'studio' ? 'checked' : ''}> ${tr(l, 'Paga no dia', 'Pays on the day')}</label>
    ${methods.includes('mbway') ? html`<label class="check"><input type="radio" name="payment" value="mbway" ${v('payment') === 'mbway' ? 'checked' : ''}> ${tr(l, 'Enviar pedido MB WAY do sinal', 'Send an MB WAY request for the deposit')}</label>` : ''}
    ${methods.includes('multibanco') ? html`<label class="check"><input type="radio" name="payment" value="multibanco" ${v('payment') === 'multibanco' ? 'checked' : ''}> ${tr(l, 'Enviar referência Multibanco do sinal', 'Send a Multibanco reference for the deposit')}</label>` : ''}
    <label class="check"><input type="checkbox" name="notify" ${values.notify === undefined || values.notify ? 'checked' : ''}> ${tr(l, 'Enviar confirmação ao cliente', 'Send the customer a confirmation')}</label>
  </fieldset>
  <button class="btn" type="submit">${tr(l, 'Criar marcação', 'Create booking')}</button>
</form>`;
  return htmlReply(adminPage(ctx, { title: tr(l, 'Nova marcação', 'New booking'), body, scripts: ['/static/js/admin-booking.js'] }), Object.keys(errors).length || message ? 422 : 200);
}

export async function newBookingSubmit(ctx: Ctx): Promise<Reply> {
  const tenant = ctx.tenant!;
  const l = ctx.locale;
  const body = await readBody(ctx);
  const errs = new FieldErrors();
  const serviceId = uuid(body, 'service', errs);
  const staffId = uuid(body, 'staff', errs, false);
  const date = String(body.date ?? '');
  if (!isDateStr(date)) errs.add('date', 'invalid');
  const minutes = hhmmToMinutes(String(body.time ?? ''));
  if (minutes === null) errs.add('time', 'invalid');
  const name = str(body, 'name', errs, { min: 2, max: 80 });
  const phone = phoneField(body, 'phone', errs);
  const email = emailField(body, 'email', errs, false);
  const note = str(body, 'note', errs, { max: 600, required: false });
  const locale = body.locale === 'en' ? 'en' : 'pt';
  const payment = oneOf(body, 'payment', ['studio', 'mbway', 'multibanco'] as const, errs, 'studio');
  const values = { ...body, override: bool(body, 'override'), notify: bool(body, 'notify') };
  if (!errs.ok || !serviceId || minutes === null) return newBookingForm(ctx, errs.errors, values);

  try {
    const created = await createBooking(tenant, {
      serviceId, staffId, start: zonedToUtc(date, minutes, tenant.timezone),
      customer: { name, phone, email, locale, note, marketingConsent: false },
      source: 'admin', payment, ignoreRules: bool(body, 'override'),
    });
    if (bool(body, 'notify') || payment !== 'studio') afterBookingCreated(tenant.id, created);
    return redirect(`/admin/bookings/${created.booking.id}?ok=created`);
  } catch (err) {
    if (err instanceof BookingError) {
      const msg = err.code === 'slot_unavailable'
        ? tr(l, 'Este horário não está livre. Escolha outra hora ou outra pessoa, ou permita fora do horário.', 'That time isn’t free. Pick another time or person, or allow outside working hours.')
        : err.code.startsWith('payment_')
          ? tr(l, 'Não foi possível pedir o pagamento. Verifique o telemóvel (MB WAY precisa de número português) ou escolha “Paga no dia”.', 'The payment request failed. Check the phone (MB WAY needs a Portuguese number) or choose “Pays on the day”.')
          : tr(l, 'Não foi possível criar a marcação.', 'The booking couldn’t be created.');
      return newBookingForm(ctx, {}, values, msg);
    }
    throw err;
  }
}

/** Free times for the owner's booking form (ignores the online lead time). */
export async function adminSlots(ctx: Ctx): Promise<Reply> {
  const tenant = ctx.tenant!;
  const serviceId = ctx.query.get('service');
  const date = ctx.query.get('date');
  const staffId = ctx.query.get('staff');
  if (!isUuid(serviceId) || !isDateStr(date) || (staffId && !isUuid(staffId))) throw new HttpError(400, 'Invalid query');
  const r = await getSlots(tenant, serviceId, date, staffId || null, { ignoreRules: true });
  const now = Date.now();
  return jsonReply({ slots: (r?.slots ?? []).filter((s) => s.start.getTime() > now - 3_600_000).map((s) => ({ time: formatTime(s.start, tenant.timezone, 'pt') })) });
}
