// Treatments, team (with weekly hours) and time off.
import { sql } from '../../db.ts';
import { html } from '../../lib/html.ts';
import { loc } from '../../lib/i18n.ts';
import { formatDateLong, formatMoney, formatTime, hhmmToMinutes, isDateStr, localDateStr, minutesToHHMM, zonedToUtc } from '../../lib/time.ts';
import { FieldErrors, bool, euros, httpUrl, int, isUuid, str, uuid } from '../../lib/validate.ts';
import { HttpError, htmlReply, readBody, redirect, type Ctx, type Reply } from '../../http/core.ts';
import { listServices, listStaff, type Service, type Staff } from '../../domain/bookings.ts';
import { adminPage, csrfField, fieldError, flashFrom, tr } from './layout.ts';

// --- Treatments -------------------------------------------------------------
export async function servicesPage(ctx: Ctx): Promise<Reply> {
  const l = ctx.locale;
  const services = await listServices(ctx.tenant!.id, false);
  const body = html`
<header class="adm-head"><h1>${tr(l, 'Tratamentos', 'Treatments')}</h1><a class="btn" href="/admin/services/new">${tr(l, 'Novo tratamento', 'New treatment')}</a></header>
${services.length ? html`<table class="table">
  <thead><tr><th>${tr(l, 'Nome', 'Name')}</th><th>${tr(l, 'Duração', 'Length')}</th><th>${tr(l, 'Preço', 'Price')}</th><th>${tr(l, 'Online', 'Online')}</th></tr></thead>
  <tbody>${services.map((s) => html`<tr>
    <td><a href="/admin/services/${s.id}">${loc(s as unknown as Record<string, unknown>, 'name', l)}</a>${s.category ? html`<br><span class="muted">${s.category}</span>` : ''}</td>
    <td>${s.duration_min} min${s.buffer_min ? html` <span class="muted">+${s.buffer_min}</span>` : ''}</td>
    <td>${formatMoney(s.price_cents, l)}</td>
    <td>${s.active ? tr(l, 'Sim', 'Yes') : tr(l, 'Escondido', 'Hidden')}</td></tr>`)}
  </tbody></table>` : html`<p class="empty">${tr(l, 'Adicione o primeiro tratamento para aparecer no site.', 'Add your first treatment so it shows on the site.')}</p>`}`;
  return htmlReply(adminPage(ctx, { title: tr(l, 'Tratamentos', 'Treatments'), body, flash: flashFrom(ctx) }));
}

export async function serviceForm(ctx: Ctx, errors: Record<string, string> = {}, posted?: Record<string, unknown>): Promise<Reply> {
  const tenant = ctx.tenant!;
  const l = ctx.locale;
  const isNew = ctx.params.id === undefined;
  let s: Partial<Service> = { duration_min: 60, buffer_min: 15, price_cents: 0, active: true, sort: 0 };
  let assigned: string[] = [];
  if (!isNew) {
    if (!isUuid(ctx.params.id)) throw new HttpError(404, 'Not found');
    const [row] = await sql<Service[]>`select * from services where tenant_id = ${tenant.id} and id = ${ctx.params.id}`;
    if (!row) throw new HttpError(404, 'Not found');
    s = row;
    assigned = (await sql<{ staff_id: string }[]>`select staff_id from staff_services where service_id = ${row.id}`).map((r) => r.staff_id);
  }
  const staff = await listStaff(tenant.id, false);
  if (isNew) assigned = staff.map((x) => x.id);
  const p = (k: string, fallback: unknown) => (posted && posted[k] !== undefined ? String(posted[k]) : fallback === undefined || fallback === null ? '' : String(fallback));
  const euro = (c: number | undefined) => ((c ?? 0) / 100).toFixed(2).replace('.', l === 'pt' ? ',' : '.');

  const body = html`
<h1>${isNew ? tr(l, 'Novo tratamento', 'New treatment') : loc(s as Record<string, unknown>, 'name', l)}</h1>
<form method="post" action="${isNew ? '/admin/services/new' : `/admin/services/${s.id}`}" class="form">${csrfField(ctx)}
  <div class="row">
    <label>${tr(l, 'Nome (português)', 'Name (Portuguese)')}<input name="name_pt" value="${p('name_pt', s.name_pt)}" required maxlength="80">${fieldError(errors, 'name_pt', l)}</label>
    <label>${tr(l, 'Nome (inglês)', 'Name (English)')}<input name="name_en" value="${p('name_en', s.name_en)}" maxlength="80"></label>
  </div>
  <label>${tr(l, 'Descrição (português)', 'Description (Portuguese)')}<textarea name="description_pt" rows="2" maxlength="400">${p('description_pt', s.description_pt)}</textarea></label>
  <label>${tr(l, 'Descrição (inglês)', 'Description (English)')}<textarea name="description_en" rows="2" maxlength="400">${p('description_en', s.description_en)}</textarea></label>
  <label>${tr(l, 'Categoria (agrupa no site)', 'Category (groups them on the site)')}<input name="category" value="${p('category', s.category)}" maxlength="40"></label>
  <div class="row">
    <label>${tr(l, 'Duração (min)', 'Length (min)')}<input name="duration_min" type="number" min="5" max="600" step="5" value="${p('duration_min', s.duration_min)}" required>${fieldError(errors, 'duration_min', l)}</label>
    <label>${tr(l, 'Intervalo depois (min)', 'Break after (min)')}<input name="buffer_min" type="number" min="0" max="120" step="5" value="${p('buffer_min', s.buffer_min)}">${fieldError(errors, 'buffer_min', l)}</label>
    <label>${tr(l, 'Preço (€)', 'Price (€)')}<input name="price" inputmode="decimal" value="${posted ? p('price', '') : euro(s.price_cents)}" required>${fieldError(errors, 'price', l)}</label>
    <label>${tr(l, 'Ordem', 'Order')}<input name="sort" type="number" value="${p('sort', s.sort)}"></label>
  </div>
  <fieldset><legend>${tr(l, 'Quem faz este tratamento', 'Who does this treatment')}</legend>
    ${staff.map((st) => html`<label class="check"><input type="checkbox" name="staff[]" value="${st.id}" ${assigned.includes(st.id) ? 'checked' : ''}> ${st.name}</label>`)}
    ${staff.length ? '' : html`<p class="muted">${tr(l, 'Adicione primeiro a equipa.', 'Add your team first.')}</p>`}
  </fieldset>
  <label class="check"><input type="checkbox" name="active" ${(posted ? bool(posted, 'active') : s.active) ? 'checked' : ''}> ${tr(l, 'Mostrar no site e aceitar marcações online', 'Show on the site and take online bookings')}</label>
  <button class="btn" type="submit">${tr(l, 'Guardar', 'Save')}</button>
</form>`;
  return htmlReply(adminPage(ctx, { title: tr(l, 'Tratamento', 'Treatment'), body }), Object.keys(errors).length ? 422 : 200);
}

export async function serviceSave(ctx: Ctx): Promise<Reply> {
  const tenant = ctx.tenant!;
  const body = await readBody(ctx);
  const errs = new FieldErrors();
  const v = {
    name_pt: str(body, 'name_pt', errs, { max: 80 }),
    name_en: str(body, 'name_en', errs, { max: 80, required: false }),
    description_pt: str(body, 'description_pt', errs, { max: 400, required: false }),
    description_en: str(body, 'description_en', errs, { max: 400, required: false }),
    category: str(body, 'category', errs, { max: 40, required: false }),
    duration_min: int(body, 'duration_min', errs, { min: 5, max: 600 }),
    buffer_min: int(body, 'buffer_min', errs, { min: 0, max: 120, required: false }),
    price_cents: euros(body, 'price', errs),
    sort: int(body, 'sort', errs, { min: -1000, max: 1000, required: false }),
    active: bool(body, 'active'),
  };
  if (!errs.ok) return serviceForm(ctx, errs.errors, body);
  const staffIds = (Array.isArray(body.staff) ? body.staff : []).filter(isUuid) as string[];

  const id = await sql.begin(async (tx) => {
    let serviceId = ctx.params.id;
    if (serviceId === undefined) {
      const [row] = await tx<{ id: string }[]>`insert into services ${tx({ ...v, tenant_id: tenant.id })} returning id`;
      serviceId = row.id;
    } else {
      if (!isUuid(serviceId)) throw new HttpError(404, 'Not found');
      const r = await tx`update services set ${tx(v)} where tenant_id = ${tenant.id} and id = ${serviceId} returning id`;
      if (!r.length) throw new HttpError(404, 'Not found');
    }
    await tx`delete from staff_services where service_id = ${serviceId}`;
    if (staffIds.length) {
      // Only therapists of this studio: the composite foreign key rejects others.
      await tx`insert into staff_services ${tx(staffIds.map((s) => ({ tenant_id: tenant.id, staff_id: s, service_id: serviceId })))}`;
    }
    return serviceId;
  });
  void id;
  return redirect('/admin/services?ok=saved');
}

// --- Team -----------------------------------------------------------------------
export async function teamPage(ctx: Ctx): Promise<Reply> {
  const l = ctx.locale;
  const staff = await listStaff(ctx.tenant!.id, false);
  const hours = await sql<{ staff_id: string; weekday: number; start_min: number; end_min: number }[]>`
    select staff_id, weekday, start_min, end_min from working_hours where tenant_id = ${ctx.tenant!.id} order by weekday, start_min`;
  const dayShort = l === 'en' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const summary = (id: string) => [1, 2, 3, 4, 5, 6, 0].filter((d) => hours.some((h) => h.staff_id === id && h.weekday === d)).map((d) => dayShort[d]).join(' ');
  const body = html`
<header class="adm-head"><h1>${tr(l, 'Equipa', 'Team')}</h1>
  <a class="btn btn-quiet" href="/admin/time-off">${tr(l, 'Folgas e férias', 'Time off')}</a>
  <a class="btn" href="/admin/team/new">${tr(l, 'Adicionar terapeuta', 'Add therapist')}</a></header>
${staff.length ? html`<table class="table"><thead><tr><th>${tr(l, 'Nome', 'Name')}</th><th>${tr(l, 'Dias', 'Days')}</th><th>${tr(l, 'Online', 'Online')}</th></tr></thead>
  <tbody>${staff.map((s) => html`<tr><td><a href="/admin/team/${s.id}">${s.name}</a></td><td>${summary(s.id) || html`<span class="muted">${tr(l, 'Sem horário', 'No hours set')}</span>`}</td><td>${s.active ? tr(l, 'Sim', 'Yes') : tr(l, 'Inativo', 'Inactive')}</td></tr>`)}</tbody></table>`
  : html`<p class="empty">${tr(l, 'Adicione quem faz os tratamentos e em que dias trabalha.', 'Add who does the treatments and which days they work.')}</p>`}`;
  return htmlReply(adminPage(ctx, { title: tr(l, 'Equipa', 'Team'), body, flash: flashFrom(ctx) }));
}

export async function staffForm(ctx: Ctx, errors: Record<string, string> = {}): Promise<Reply> {
  const tenant = ctx.tenant!;
  const l = ctx.locale;
  const isNew = ctx.params.id === undefined;
  let s: Partial<Staff> = { active: true, sort: 0 };
  let hours: { weekday: number; start_min: number; end_min: number }[] = [];
  if (!isNew) {
    if (!isUuid(ctx.params.id)) throw new HttpError(404, 'Not found');
    const [row] = await sql<Staff[]>`select * from staff where tenant_id = ${tenant.id} and id = ${ctx.params.id}`;
    if (!row) throw new HttpError(404, 'Not found');
    s = row;
    hours = await sql`select weekday, start_min, end_min from working_hours where staff_id = ${row.id} order by weekday, start_min`;
  } else {
    hours = [1, 2, 3, 4, 5].map((d) => ({ weekday: d, start_min: 600, end_min: 1140 }));
  }
  const days = [1, 2, 3, 4, 5, 6, 0];
  const names = l === 'en' ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] : ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const shift = (d: number, i: number) => hours.filter((h) => h.weekday === d)[i];

  const body = html`
<h1>${isNew ? tr(l, 'Adicionar terapeuta', 'Add therapist') : s.name}</h1>
<form method="post" action="${isNew ? '/admin/team/new' : `/admin/team/${s.id}`}" class="form">${csrfField(ctx)}
  <label>${tr(l, 'Nome', 'Name')}<input name="name" value="${s.name ?? ''}" required maxlength="60">${fieldError(errors, 'name', l)}</label>
  <div class="row">
    <label>${tr(l, 'Especialidade (português)', 'Specialty (Portuguese)')}<input name="title_pt" value="${s.title_pt ?? ''}" maxlength="80"></label>
    <label>${tr(l, 'Especialidade (inglês)', 'Specialty (English)')}<input name="title_en" value="${s.title_en ?? ''}" maxlength="80"></label>
  </div>
  <label>${tr(l, 'Apresentação (português)', 'Short bio (Portuguese)')}<textarea name="bio_pt" rows="2" maxlength="400">${s.bio_pt ?? ''}</textarea></label>
  <label>${tr(l, 'Apresentação (inglês)', 'Short bio (English)')}<textarea name="bio_en" rows="2" maxlength="400">${s.bio_en ?? ''}</textarea></label>
  <label>${tr(l, 'Foto (link https)', 'Photo (https link)')}<input name="photo_url" type="url" value="${s.photo_url ?? ''}">${fieldError(errors, 'photo_url', l)}</label>
  <fieldset><legend>${tr(l, 'Horário semanal', 'Weekly hours')}</legend>
    <p class="muted">${tr(l, 'Deixe em branco os dias de folga. Use o segundo turno para pausas (ex.: 10:00–13:00 e 14:00–19:00).', 'Leave days off blank. Use the second shift for breaks (e.g. 10:00–13:00 and 14:00–19:00).')}</p>
    <table class="hours-edit"><tbody>
    ${days.map((d) => html`<tr><th scope="row">${names[d]}</th>
      ${[0, 1].map((i) => {
        const sh = shift(d, i);
        return html`<td><input type="time" name="h_${d}_${i}_start" value="${sh ? minutesToHHMM(sh.start_min) : ''}" aria-label="${names[d]} ${i + 1} ${tr(l, 'início', 'start')}"> – <input type="time" name="h_${d}_${i}_end" value="${sh ? minutesToHHMM(sh.end_min) : ''}" aria-label="${names[d]} ${i + 1} ${tr(l, 'fim', 'end')}"></td>`;
      })}</tr>`)}
    </tbody></table>${fieldError(errors, 'hours', l)}
  </fieldset>
  <div class="row">
    <label>${tr(l, 'Ordem no site', 'Order on the site')}<input name="sort" type="number" value="${s.sort ?? 0}"></label>
  </div>
  <label class="check"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}> ${tr(l, 'Ativo (aparece no site e recebe marcações)', 'Active (shown on the site and bookable)')}</label>
  <button class="btn" type="submit">${tr(l, 'Guardar', 'Save')}</button>
</form>`;
  return htmlReply(adminPage(ctx, { title: tr(l, 'Terapeuta', 'Therapist'), body }), Object.keys(errors).length ? 422 : 200);
}

export async function staffSave(ctx: Ctx): Promise<Reply> {
  const tenant = ctx.tenant!;
  const body = await readBody(ctx);
  const errs = new FieldErrors();
  const v = {
    name: str(body, 'name', errs, { max: 60 }),
    title_pt: str(body, 'title_pt', errs, { max: 80, required: false }),
    title_en: str(body, 'title_en', errs, { max: 80, required: false }),
    bio_pt: str(body, 'bio_pt', errs, { max: 400, required: false }),
    bio_en: str(body, 'bio_en', errs, { max: 400, required: false }),
    photo_url: httpUrl(body, 'photo_url', errs),
    sort: int(body, 'sort', errs, { min: -1000, max: 1000, required: false }),
    active: bool(body, 'active'),
  };
  const shifts: { weekday: number; start_min: number; end_min: number }[] = [];
  for (let d = 0; d < 7; d++) {
    for (let i = 0; i < 2; i++) {
      const a = String(body[`h_${d}_${i}_start`] ?? '').trim(), b = String(body[`h_${d}_${i}_end`] ?? '').trim();
      if (!a && !b) continue;
      const s = hhmmToMinutes(a), e = hhmmToMinutes(b);
      if (s === null || e === null || e <= s) { errs.add('hours', 'invalid'); continue; }
      shifts.push({ weekday: d, start_min: s, end_min: e });
    }
  }
  if (!errs.ok) return staffForm(ctx, errs.errors);

  await sql.begin(async (tx) => {
    let staffId = ctx.params.id;
    if (staffId === undefined) {
      const [row] = await tx<{ id: string }[]>`insert into staff ${tx({ ...v, tenant_id: tenant.id })} returning id`;
      staffId = row.id;
      // New therapists can do every treatment until the owner says otherwise.
      await tx`insert into staff_services (tenant_id, staff_id, service_id) select ${tenant.id}, ${staffId}, id from services where tenant_id = ${tenant.id}`;
    } else {
      if (!isUuid(staffId)) throw new HttpError(404, 'Not found');
      const r = await tx`update staff set ${tx(v)} where tenant_id = ${tenant.id} and id = ${staffId} returning id`;
      if (!r.length) throw new HttpError(404, 'Not found');
    }
    await tx`delete from working_hours where staff_id = ${staffId}`;
    if (shifts.length) await tx`insert into working_hours ${tx(shifts.map((s) => ({ ...s, tenant_id: tenant.id, staff_id: staffId })))}`;
  });
  return redirect('/admin/team?ok=saved');
}

// --- Time off ----------------------------------------------------------------------
export async function timeOffPage(ctx: Ctx, errors: Record<string, string> = {}): Promise<Reply> {
  const tenant = ctx.tenant!;
  const l = ctx.locale;
  const tz = tenant.timezone;
  const [staff, rows] = await Promise.all([
    listStaff(tenant.id, false),
    sql<{ id: string; staff_id: string | null; starts_at: Date; ends_at: Date; reason: string; staff_name: string | null }[]>`
      select t.*, s.name as staff_name from time_off t left join staff s on s.id = t.staff_id
      where t.tenant_id = ${tenant.id} and t.ends_at > now() order by t.starts_at`,
  ]);
  const today = localDateStr(new Date(), tz);
  const body = html`
<h1>${tr(l, 'Folgas e férias', 'Time off')}</h1>
<p class="muted">${tr(l, 'Bloqueie dias ou horas para um terapeuta ou para todo o estúdio (feriados, formação, férias).', 'Block days or hours for one therapist or the whole studio (holidays, training, vacation).')}</p>
${rows.length ? html`<ul class="plain">${rows.map((r) => html`<li>
  <strong>${r.staff_name ?? tr(l, 'Todo o estúdio', 'Whole studio')}</strong>:
  ${formatDateLong(r.starts_at, tz, l)} ${formatTime(r.starts_at, tz, l)} – ${formatDateLong(r.ends_at, tz, l)} ${formatTime(r.ends_at, tz, l)}
  ${r.reason ? html`<span class="muted">(${r.reason})</span>` : ''}
  <form method="post" action="/admin/time-off/${r.id}/delete" class="inline">${csrfField(ctx)}<button class="linklike" type="submit">${tr(l, 'Remover', 'Remove')}</button></form>
</li>`)}</ul>` : html`<p class="empty">${tr(l, 'Sem folgas marcadas.', 'No time off planned.')}</p>`}
<h2>${tr(l, 'Adicionar', 'Add')}</h2>
<form method="post" action="/admin/time-off" class="form">${csrfField(ctx)}
  <label>${tr(l, 'Quem', 'Who')}<select name="staff"><option value="">${tr(l, 'Todo o estúdio', 'Whole studio')}</option>${staff.map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select></label>
  <div class="row">
    <label>${tr(l, 'De (dia)', 'From (day)')}<input type="date" name="from_date" value="${today}" required></label>
    <label>${tr(l, 'Hora', 'Time')}<input type="time" name="from_time" value="00:00"></label>
    <label>${tr(l, 'Até (dia)', 'Until (day)')}<input type="date" name="to_date" value="${today}" required></label>
    <label>${tr(l, 'Hora', 'Time')}<input type="time" name="to_time" value="23:59"></label>
  </div>${fieldError(errors, 'range', l)}
  <label>${tr(l, 'Motivo (só para si)', 'Reason (only you see it)')}<input name="reason" maxlength="80"></label>
  <button class="btn" type="submit">${tr(l, 'Bloquear', 'Block')}</button>
</form>`;
  return htmlReply(adminPage(ctx, { title: tr(l, 'Folgas', 'Time off'), body, flash: flashFrom(ctx) }), Object.keys(errors).length ? 422 : 200);
}

export async function timeOffAdd(ctx: Ctx): Promise<Reply> {
  const tenant = ctx.tenant!;
  const body = await readBody(ctx);
  const errs = new FieldErrors();
  const staffId = uuid(body, 'staff', errs, false);
  const fd = String(body.from_date ?? ''), td = String(body.to_date ?? '');
  const ft = hhmmToMinutes(String(body.from_time || '00:00')), tt = hhmmToMinutes(String(body.to_time || '23:59'));
  if (!isDateStr(fd) || !isDateStr(td) || ft === null || tt === null) { errs.add('range', 'invalid'); return timeOffPage(ctx, errs.errors); }
  const start = zonedToUtc(fd, ft, tenant.timezone);
  const end = zonedToUtc(td, tt === 1439 ? 1440 : tt, tenant.timezone);
  if (end <= start) { errs.add('range', 'invalid'); return timeOffPage(ctx, errs.errors); }
  const reason = str(body, 'reason', errs, { max: 80, required: false });
  await sql`insert into time_off (tenant_id, staff_id, starts_at, ends_at, reason) values (${tenant.id}, ${staffId}, ${start}, ${end}, ${reason})`;
  return redirect('/admin/time-off?ok=saved');
}

export async function timeOffDelete(ctx: Ctx): Promise<Reply> {
  if (!isUuid(ctx.params.id)) throw new HttpError(404, 'Not found');
  await sql`delete from time_off where tenant_id = ${ctx.tenant!.id} and id = ${ctx.params.id}`;
  return redirect('/admin/time-off?ok=deleted');
}
