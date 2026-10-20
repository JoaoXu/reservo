// Customer list, CSV export and erasure (GDPR rights of access and erasure).
import { sql } from '../../db.ts';
import { html } from '../../lib/html.ts';
import { formatDateLong } from '../../lib/time.ts';
import { isUuid } from '../../lib/validate.ts';
import { HttpError, htmlReply, redirect, type Ctx, type Reply } from '../../http/core.ts';
import { adminPage, csrfField, flashFrom, tr } from './layout.ts';

interface CustomerRow { id: string; name: string; phone: string; email: string | null; marketing_consent: boolean; created_at: Date; bookings: number; last_visit: Date | null }

export async function customersPage(ctx: Ctx): Promise<Reply> {
  const t = ctx.tenant!;
  const l = ctx.locale;
  const q = (ctx.query.get('q') ?? '').trim().slice(0, 60);
  const search = q ? sql`and (c.name ilike ${'%' + q.replace(/[%_\\]/g, '\\$&') + '%'} or c.phone like ${'%' + q.replace(/\D/g, '') + '%'})` : sql``;
  const rows = await sql<CustomerRow[]>`
    select c.id, c.name, c.phone, c.email, c.marketing_consent, c.created_at,
      count(b.id)::int as bookings, max(b.starts_at) filter (where b.status in ('confirmed','completed')) as last_visit
    from customers c left join bookings b on b.customer_id = c.id
    where c.tenant_id = ${t.id} and c.anonymized_at is null ${search}
    group by c.id order by max(b.starts_at) desc nulls last limit 300`;
  const body = html`
<header class="adm-head"><h1>${tr(l, 'Clientes', 'Customers')}</h1>
  <a class="btn btn-quiet" href="/admin/customers.csv">${tr(l, 'Exportar CSV', 'Export CSV')}</a></header>
<form class="search" method="get" action="/admin/customers">
  <input type="search" name="q" value="${q}" placeholder="${tr(l, 'Nome ou telemóvel', 'Name or phone')}" aria-label="${tr(l, 'Procurar', 'Search')}">
  <button class="btn btn-quiet" type="submit">${tr(l, 'Procurar', 'Search')}</button>
</form>
${rows.length ? html`<table class="table"><thead><tr><th>${tr(l, 'Nome', 'Name')}</th><th>${tr(l, 'Contacto', 'Contact')}</th><th>${tr(l, 'Marcações', 'Bookings')}</th><th>${tr(l, 'Última visita', 'Last visit')}</th><th></th></tr></thead>
<tbody>${rows.map((r) => html`<tr>
  <td>${r.name}${r.marketing_consent ? html` <span class="badge">${tr(l, 'aceita novidades', 'opted in')}</span>` : ''}</td>
  <td>${r.phone}${r.email ? html`<br><span class="muted">${r.email}</span>` : ''}</td>
  <td>${r.bookings}</td>
  <td>${r.last_visit ? formatDateLong(r.last_visit, t.timezone, l) : '–'}</td>
  <td><form method="post" action="/admin/customers/${r.id}/erase" data-confirm="${tr(l, 'Apagar os dados pessoais deste cliente? O histórico de marcações fica anónimo. Não pode ser desfeito.', 'Erase this customer’s personal data? Booking history stays, anonymised. This can’t be undone.')}">${csrfField(ctx)}<button class="linklike" type="submit">${tr(l, 'Apagar dados', 'Erase data')}</button></form></td>
</tr>`)}</tbody></table>` : html`<p class="empty">${tr(l, 'Os clientes aparecem aqui depois da primeira marcação.', 'Customers appear here after their first booking.')}</p>`}`;
  return htmlReply(adminPage(ctx, { title: tr(l, 'Clientes', 'Customers'), body, flash: flashFrom(ctx) }));
}

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  // Stop spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export async function customersCsv(ctx: Ctx): Promise<Reply> {
  const t = ctx.tenant!;
  const rows = await sql<CustomerRow[]>`
    select c.id, c.name, c.phone, c.email, c.marketing_consent, c.created_at, count(b.id)::int as bookings, max(b.starts_at) as last_visit
    from customers c left join bookings b on b.customer_id = c.id
    where c.tenant_id = ${t.id} and c.anonymized_at is null group by c.id order by c.name`;
  const header = ['name', 'phone', 'email', 'marketing_consent', 'created_at', 'bookings', 'last_booking'];
  const lines = [header.join(','), ...rows.map((r) => [r.name, r.phone, r.email, r.marketing_consent, r.created_at, r.bookings, r.last_visit].map(csvCell).join(','))];
  await sql`insert into audit_log (tenant_id, user_id, action) values (${t.id}, ${ctx.session!.userId}, 'customers.export')`;
  return { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="clientes-${t.slug}.csv"`, 'cache-control': 'no-store' }, body: '﻿' + lines.join('\r\n') };
}

export async function customerErase(ctx: Ctx): Promise<Reply> {
  if (!isUuid(ctx.params.id)) throw new HttpError(404, 'Not found');
  const t = ctx.tenant!;
  await sql`update customers set name = 'Cliente removido', phone = 'anon-' || id, email = null, notes = '', marketing_consent = false, anonymized_at = now()
            where tenant_id = ${t.id} and id = ${ctx.params.id}`;
  await sql`update bookings set customer_note = '' where tenant_id = ${t.id} and customer_id = ${ctx.params.id}`;
  await sql`insert into audit_log (tenant_id, user_id, action, details) values (${t.id}, ${ctx.session!.userId}, 'customer.erased', ${sql.json({ customer: ctx.params.id })})`;
  return redirect('/admin/customers?ok=anonymized');
}
