import { sql } from '../db.ts';
import { html, paragraphs, safeUrl, type SafeHtml } from '../lib/html.ts';
import { t, loc, type Locale, type MsgKey } from '../lib/i18n.ts';
import { formatMoney, formatTime, localDateStr, addDays, minutesToHHMM } from '../lib/time.ts';
import { htmlReply, type Ctx, type Reply } from '../http/core.ts';
import { listServices, listStaff, nextOpenings, type Service, type Staff } from '../domain/bookings.ts';
import type { Tenant } from '../domain/tenants.ts';
import { sitePage, whatsappLink } from './layout.ts';

/** Studio opening hours per weekday: the union of all therapists' shifts. */
export async function studioHours(tenantId: string): Promise<Map<number, { start: number; end: number }>> {
  const rows = await sql<{ weekday: number; start_min: number; end_min: number }[]>`
    select w.weekday, min(w.start_min)::int as start_min, max(w.end_min)::int as end_min
    from working_hours w join staff s on s.id = w.staff_id
    where w.tenant_id = ${tenantId} and s.active
    group by w.weekday`;
  return new Map(rows.map((r) => [r.weekday, { start: r.start_min, end: r.end_min }]));
}

function dayLabel(date: string, tenant: Tenant, l: Locale, startUtc: Date): string {
  const today = localDateStr(new Date(), tenant.timezone);
  if (date === today) return t(l, 'hero.today');
  if (date === addDays(today, 1)) return t(l, 'hero.tomorrow');
  return new Intl.DateTimeFormat(l === 'en' ? 'en-GB' : 'pt-PT', { timeZone: tenant.timezone, weekday: 'long', day: 'numeric' }).format(startUtc);
}

function monogram(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

function serviceRow(s: Service, l: Locale): SafeHtml {
  const desc = loc(s as unknown as Record<string, unknown>, 'description', l);
  return html`<li class="menu-item">
    <div class="menu-text">
      <h3>${loc(s as unknown as Record<string, unknown>, 'name', l)}</h3>
      ${desc ? html`<p>${desc}</p>` : ''}
    </div>
    <div class="menu-meta">
      <span class="menu-duration">${s.duration_min} ${t(l, 'services.min')}</span>
      <span class="menu-price">${formatMoney(s.price_cents, l)}</span>
      <a class="menu-book" href="/marcar?servico=${s.id}" aria-label="${t(l, 'services.book')}: ${loc(s as unknown as Record<string, unknown>, 'name', l)}">${t(l, 'services.book')}</a>
    </div>
  </li>`;
}

function staffCard(s: Staff, l: Locale): SafeHtml {
  const photo = safeUrl(s.photo_url);
  const title = loc(s as unknown as Record<string, unknown>, 'title', l);
  const bio = loc(s as unknown as Record<string, unknown>, 'bio', l);
  return html`<li class="person">
    ${photo ? html`<img class="person-photo" src="${photo}" alt="" loading="lazy" width="120" height="120">` : html`<span class="person-photo person-mono" aria-hidden="true">${monogram(s.name)}</span>`}
    <div>
      <h3>${s.name}</h3>
      ${title ? html`<p class="person-title">${title}</p>` : ''}
      ${bio ? html`<p>${bio}</p>` : ''}
    </div>
  </li>`;
}

export async function homePage(ctx: Ctx): Promise<Reply> {
  const tenant = ctx.tenant!;
  const l = ctx.locale;
  const c = tenant.content;
  const [services, staff, hours] = await Promise.all([listServices(tenant.id), listStaff(tenant.id), studioHours(tenant.id)]);
  const featured = services[0];
  const openings = featured ? await nextOpenings(tenant, featured.id, 6, 7) : [];

  // Group by category, keeping the owner's order.
  const groups: { name: string; items: Service[] }[] = [];
  for (const s of services) {
    const g = groups.find((x) => x.name === s.category);
    if (g) g.items.push(s); else groups.push({ name: s.category, items: [s] });
  }

  const wa = whatsappLink(c.whatsapp, l === 'en' ? 'Hello! I would like to book a treatment.' : 'Olá! Gostaria de marcar um tratamento.');
  const tagline = loc(c as Record<string, unknown>, 'tagline', l) || tenant.name;
  const intro = loc(c as Record<string, unknown>, 'intro', l);
  const about = loc(c as Record<string, unknown>, 'about', l);
  const hoursNote = loc(c as Record<string, unknown>, 'hours_note', l);
  const weekOrder = [1, 2, 3, 4, 5, 6, 0];

  const body = html`
<section class="hero">
  <div class="hero-copy">
    <h1 class="hero-title">${tagline}</h1>
    ${intro ? html`<p class="hero-intro">${intro}</p>` : ''}
    <div class="hero-actions">
      <a class="btn" href="/marcar">${t(l, 'hero.book_cta')}</a>
      ${wa ? html`<a class="btn btn-quiet" href="${wa}" rel="noopener" target="_blank">${t(l, 'hero.whatsapp')}</a>` : ''}
    </div>
  </div>
  <svg class="tide" viewBox="0 0 1200 120" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <path class="tide-a" d="M0 70 C150 40 300 100 450 70 S750 40 900 70 S1100 100 1200 70 V120 H0Z"/>
    <path class="tide-b" d="M0 85 C200 60 350 110 550 85 S850 60 1000 85 S1150 105 1200 85 V120 H0Z"/>
  </svg>
  ${featured ? html`<aside class="openings" aria-labelledby="openings-title">
    <h2 id="openings-title">${t(l, 'hero.next')}</h2>
    <p class="openings-service">${loc(featured as unknown as Record<string, unknown>, 'name', l)}, ${featured.duration_min} ${t(l, 'services.min')}</p>
    ${openings.length ? html`<ul class="openings-list">
      ${openings.map((o) => html`<li><a href="/marcar?servico=${featured.id}&amp;data=${o.date}&amp;hora=${o.start.toISOString()}">
        <span class="openings-day">${dayLabel(o.date, tenant, l, o.start)}</span>
        <span class="openings-time">${formatTime(o.start, tenant.timezone, l)}</span></a></li>`)}
    </ul>` : html`<p class="muted">${t(l, 'hero.next_none')}</p>`}
  </aside>` : ''}
</section>

<section class="section" id="tratamentos" aria-labelledby="services-title">
  <h2 class="section-title" id="services-title">${t(l, 'services.title')}</h2>
  ${groups.map((g) => html`<div class="menu-group">
    ${g.name ? html`<h3 class="menu-category">${g.name}</h3>` : ''}
    <ul class="menu">${g.items.map((s) => serviceRow(s, l))}</ul>
  </div>`)}
</section>

${about ? html`<section class="section about">${paragraphs(about)}</section>` : ''}

${staff.length ? html`<section class="section" id="equipa" aria-labelledby="team-title">
  <h2 class="section-title" id="team-title">${t(l, 'team.title')}</h2>
  <ul class="people">${staff.map((s) => staffCard(s, l))}</ul>
</section>` : ''}

<section class="section visit" id="visite" aria-labelledby="visit-title">
  <h2 class="section-title" id="visit-title">${t(l, 'visit.title')}</h2>
  <div class="visit-grid">
    <div>
      ${c.address ? html`<p class="visit-address">${c.address}${c.postal_code ? html`<br>${c.postal_code} ${c.city ?? ''}` : ''}</p>` : ''}
      <p class="visit-links">
        ${safeUrl(c.map_url) ? html`<a href="${safeUrl(c.map_url)}" rel="noopener" target="_blank">${t(l, 'visit.map')}</a>` : ''}
        ${c.phone ? html`<a href="tel:${c.phone.replace(/\s/g, '')}">${t(l, 'visit.call')} ${c.phone}</a>` : ''}
        ${wa ? html`<a href="${wa}" rel="noopener" target="_blank">WhatsApp</a>` : ''}
        ${c.email ? html`<a href="mailto:${c.email}">${c.email}</a>` : ''}
        ${c.instagram ? html`<a href="https://instagram.com/${c.instagram.replace(/^@/, '')}" rel="noopener" target="_blank">Instagram</a>` : ''}
      </p>
    </div>
    <div>
      <h3 class="hours-title">${t(l, 'visit.hours')}</h3>
      <table class="hours">
        <tbody>
        ${weekOrder.map((wd) => {
          const h = hours.get(wd);
          return html`<tr><th scope="row">${t(l, `weekday.${wd}` as MsgKey)}</th><td>${h ? `${minutesToHHMM(h.start)}–${minutesToHHMM(h.end)}` : t(l, 'visit.closed')}</td></tr>`;
        })}
        </tbody>
      </table>
      ${hoursNote ? html`<p class="muted">${hoursNote}</p>` : ''}
    </div>
  </div>
</section>`;

  return htmlReply(sitePage(ctx, {
    title: `${tenant.name}${c.city ? ` | ${l === 'en' ? 'Massage in' : 'Massagem em'} ${c.city}` : ''}`,
    description: intro || tagline,
    body,
    bodyClass: 'home',
  }), 200, { 'cache-control': 'private, max-age=60' });
}

export function privacyPage(ctx: Ctx): Reply {
  const tenant = ctx.tenant!;
  const c = tenant.content;
  const l = ctx.locale;
  const controller = c.legal_name || tenant.name;
  const body = l === 'en' ? html`
<article class="section prose">
  <h1>Privacy</h1>
  <p>${controller}${c.nif ? html` (NIF ${c.nif})` : ''} is responsible for the personal data you give us when booking.</p>
  <h2>What we keep and why</h2>
  <p>Your name, mobile number, optional email and any note you write, so that we can manage your appointment, confirm it and remind you. Payment details are handled by our payment provider (ifthenpay); we never see your card or bank details.</p>
  <h2>How long</h2>
  <p>We keep booking records while you are a client. Contact details of people who haven't booked for 24 months are deleted automatically.</p>
  <h2>Your rights</h2>
  <p>You can ask to see, correct or delete your data at any time${c.email ? html` by writing to <a href="mailto:${c.email}">${c.email}</a>` : ''}. You can also complain to the Comissão Nacional de Proteção de Dados (cnpd.pt).</p>
  <p>Our website is run by Reservo, which processes this data on our behalf and stores it in the European Union.</p>
</article>` : html`
<article class="section prose">
  <h1>Privacidade</h1>
  <p>${controller}${c.nif ? html` (NIF ${c.nif})` : ''} é responsável pelos dados pessoais que nos dá ao fazer uma marcação.</p>
  <h2>Que dados guardamos e porquê</h2>
  <p>O seu nome, telemóvel, email opcional e as notas que escrever, para gerir a sua marcação, confirmá-la e enviar-lhe um lembrete. Os dados de pagamento são tratados pelo nosso prestador de pagamentos (ifthenpay); nunca vemos o seu cartão ou dados bancários.</p>
  <h2>Durante quanto tempo</h2>
  <p>Guardamos o histórico de marcações enquanto for cliente. Os contactos de quem não marca há 24 meses são apagados automaticamente.</p>
  <h2>Os seus direitos</h2>
  <p>Pode pedir para consultar, corrigir ou apagar os seus dados a qualquer momento${c.email ? html`, escrevendo para <a href="mailto:${c.email}">${c.email}</a>` : ''}. Pode também apresentar reclamação à Comissão Nacional de Proteção de Dados (cnpd.pt).</p>
  <p>O nosso site é gerido pela Reservo, que trata estes dados em nosso nome e os guarda na União Europeia.</p>
</article>`;
  return htmlReply(sitePage(ctx, { title: `${l === 'en' ? 'Privacy' : 'Privacidade'} | ${tenant.name}`, body }));
}

export function policyPage(ctx: Ctx): Reply {
  const tenant = ctx.tenant!;
  const l = ctx.locale;
  const custom = loc(tenant.content as Record<string, unknown>, 'policy', l);
  const h = tenant.cancel_window_hours;
  const fallback = l === 'en'
    ? `You can cancel or change your booking free of charge up to ${h} hours before it starts, using the link in your confirmation message. ${tenant.payment_mode === 'deposit' ? `If you cancel in time, your deposit is refunded. Later cancellations and no-shows keep the deposit.` : ''}`
    : `Pode cancelar ou alterar a sua marcação sem custos até ${h} horas antes, pelo link da mensagem de confirmação. ${tenant.payment_mode === 'deposit' ? `Se cancelar dentro do prazo, devolvemos o sinal. Cancelamentos fora do prazo e faltas não têm devolução do sinal.` : ''}`;
  const body = html`<article class="section prose">
    <h1>${t(l, 'footer.policy')}</h1>
    ${paragraphs(custom || fallback)}
  </article>`;
  return htmlReply(sitePage(ctx, { title: `${t(l, 'footer.policy')} | ${tenant.name}`, body }));
}
