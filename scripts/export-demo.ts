// Builds a single self-contained HTML file of the demo studio's site and
// booking flow, for showing on a phone without a server (e.g. in a sales
// visit or as a shared link). Slots are a real snapshot of the next 14 days;
// "payments" are simulated in the browser.
//
//   npm run seed:demo -- localhost
//   npm run demo:export -- --out demo-export/mare.html [--owner-img agenda.png ...]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { AddressInfo } from 'node:net';
import { sql, closeDb } from '../src/db.ts';
import { isMain } from '../src/lib/main.ts';
import { createAppServer } from '../src/server.ts';
import { tenantForHost } from '../src/domain/tenants.ts';
import { getSlots, listServices } from '../src/domain/bookings.ts';
import { availableMethods } from '../src/domain/payments/index.ts';
import { addDays, formatTime, localDateStr } from '../src/lib/time.ts';

const root = join(import.meta.dirname, '..');

async function dataUri(path: string, type: string): Promise<string> {
  return `data:${type};base64,${(await readFile(path)).toString('base64')}`;
}

function between(s: string, start: string, end: string): string {
  const a = s.indexOf(start);
  const b = s.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`markers not found: ${start}`);
  return s.slice(a + start.length, b);
}

export async function exportDemo(out: string, ownerImgs: string[]): Promise<void> {
  const host = 'mare.localhost';
  const tenant = await tenantForHost(host);
  if (!tenant) throw new Error('Run `npm run seed:demo` first');

  const server = createAppServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const get = async (path: string) => {
    const { request } = await import('node:http');
    return new Promise<string>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path, headers: { host, 'accept-language': 'pt-PT' } }, (res) => {
        let body = ''; res.setEncoding('utf8'); res.on('data', (c) => (body += c)); res.on('end', () => resolve(body));
      }).on('error', reject).end();
    });
  };
  const home = await get('/');
  const book = await get('/marcar');
  await new Promise((r) => server.close(r));

  // Real availability snapshot: every service, next 14 days, all therapists.
  const services = await listServices(tenant.id);
  const today = localDateStr(new Date(), tenant.timezone);
  const slots: Record<string, [string, string, string[], string[]][]> = {};
  for (const s of services) {
    for (let i = 0; i < 14; i++) {
      const date = addDays(today, i);
      const r = await getSlots(tenant, s.id, date, null);
      slots[`${s.id}|${date}`] = (r?.slots ?? []).map((x) => [x.start.toISOString(), formatTime(x.start, tenant.timezone, 'pt'), x.staffIds, availableMethods(tenant, x.start)]);
    }
  }

  const fontNews = await dataUri(join(root, 'public/fonts/newsreader.woff'), 'font/woff');
  const fontFig = await dataUri(join(root, 'public/fonts/figtree.woff'), 'font/woff');
  let css = await readFile(join(root, 'public/css/site.css'), 'utf8');
  css = css.replace('/static/fonts/newsreader.woff', fontNews).replace('/static/fonts/figtree.woff', fontFig);
  const bookingJs = await readFile(join(root, 'public/js/booking.js'), 'utf8');
  const themeStyle = between(home, '<style nonce=', '</style>').replace(/^"[^"]*">/, '');

  const homeHeader = between(home, '<body class="home">', '<main id="main">').replace(/<a class="skip"[^>]*>[^<]*<\/a>/, '');
  const homeMain = between(home, '<main id="main">', '</main>');
  const bookMain = between(book, '<main id="main">', '</main>');
  const footer = between(home, '</main>', '</body>');
  const owner = await Promise.all(ownerImgs.map((p) => dataUri(p, 'image/png')));

  // In the single page, site links become in-page views.
  const relink = (h: string) => h
    .replace(/href="\/marcar\?([^"]*)"/g, (_, q) => `href="#marcar" data-preset="${q}"`)
    .replace(/href="\/marcar"/g, 'href="#marcar"')
    .replace(/href="\/#(\w+)"/g, 'href="#inicio" data-scroll="$1"')
    .replace(/href="\/"/g, 'href="#inicio"')
    .replace(/href="\/(privacidade|cancelamentos)"/g, 'href="#inicio"')
    .replace(/<a class="lang"[^>]*>[^<]*<\/a>/, '');

  const page = `<title>Maré Studio Demo</title>
<style>${css}
${themeStyle}
.view[hidden]{display:none!important}
.demo-bar{background:var(--accent);color:#fff;font:500 .875rem/1.4 var(--sans);padding:8px max(16px,env(safe-area-inset-left,0px));display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center;justify-content:center;text-align:center}
.demo-bar a{color:#fff;font-weight:700}
.owner{max-width:var(--wrap);margin:0 auto;padding:clamp(28px,5vw,56px) var(--gutter) 72px}
.owner h1{font-weight:300;font-size:clamp(2rem,4vw,3rem)}
.owner p{max-width:60ch;color:var(--ink-2)}
.owner-shots{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,1fr);gap:20px;align-items:start;margin-top:24px}
.owner-shots img{width:100%;height:auto;border-radius:14px;border:1px solid var(--line);background:#fff}
@media (max-width:760px){.owner-shots{grid-template-columns:1fr}}
.owner ul{padding-left:1.1em;max-width:60ch}
.owner li{margin-bottom:6px}
</style>
<div class="demo-bar"><span>Demonstração: estúdio fictício, pagamentos simulados.</span><a href="#inicio">Site</a><a href="#marcar">Marcar</a><a href="#dono">Painel do estúdio</a></div>
${relink(homeHeader)}
<main id="main">
<div class="view" id="v-inicio">${relink(homeMain)}</div>
<div class="view" id="v-marcar" hidden>${bookMain}</div>
<div class="view" id="v-pagar" hidden><section class="section pay" aria-live="polite"><div class="pay-panel" id="pay-panel"></div><aside class="pay-summary" id="pay-summary"></aside></section></div>
<div class="view" id="v-dono" hidden><section class="owner">
  <h1>O que o estúdio vê</h1>
  <p>Cada marcação online, por telefone ou WhatsApp cai na mesma agenda, por terapeuta. Funciona no telemóvel da receção.</p>
  <ul>
    <li>Agenda do dia por terapeuta, com o que está pago e o que falta pagar.</li>
    <li>Nova marcação em segundos para quem liga ou escreve no WhatsApp.</li>
    <li>Sinal por MB WAY ou Multibanco, direto para a conta do estúdio.</li>
    <li>Lembrete automático no dia anterior, menos faltas.</li>
    <li>Tratamentos, preços, horários, folgas e textos do site editáveis pelo dono.</li>
  </ul>
  ${owner.length ? `<div class="owner-shots">${owner.map((src, i) => `<img src="${src}" alt="${i === 0 ? 'Agenda do estúdio no computador' : 'Agenda do estúdio no telemóvel'}">`).join('')}</div>` : ''}
</section></div>
</main>
${relink(footer)}
<script>
(function(){
  'use strict';
  var SLOTS = ${JSON.stringify(slots)};
  var tz = ${JSON.stringify(tenant.timezone)};
  // Simulated API: real availability snapshot, payments approved in the browser.
  var realFetch = window.fetch.bind(window);
  function json(body, status){ return Promise.resolve(new Response(JSON.stringify(body), { status: status || 200, headers: { 'content-type': 'application/json' } })); }
  var last = null;
  window.fetch = function(url, init){
    var u = new URL(String(url), 'https://demo.invalid');
    if (u.pathname === '/api/slots') {
      var staff = u.searchParams.get('staff');
      var list = (SLOTS[u.searchParams.get('service') + '|' + u.searchParams.get('date')] || [])
        .filter(function(s){ return !staff || s[2].indexOf(staff) >= 0; })
        .map(function(s){ return { start: s[0], label: s[1], staff: staff ? [staff] : s[2], methods: s[3] }; });
      return json({ date: u.searchParams.get('date'), slots: list });
    }
    if (u.pathname === '/api/days') {
      var from = u.searchParams.get('from'), st = u.searchParams.get('staff'), days = [];
      Object.keys(SLOTS).forEach(function(k){
        var p = k.split('|');
        if (p[0] === u.searchParams.get('service') && p[1] >= from && SLOTS[k].some(function(s){ return !st || s[2].indexOf(st) >= 0; })) days.push(p[1]);
      });
      return json({ from: from, days: days });
    }
    if (u.pathname === '/api/bookings') {
      last = JSON.parse(init.body);
      return json({ ref: 'DEMO42', status: last.payment === 'none' || last.payment === 'studio' ? 'confirmed' : 'pending_payment', next: '#pagar', paymentUrl: null }, 201);
    }
    return realFetch(url, init);
  };

  var data = JSON.parse(document.getElementById('booking-data').textContent);
  function runBooking(){
__BOOKING_JS__
  }
  var app = document.getElementById('booking-app');
  function startBooking(preset){
    data.preset = preset || {};
    document.getElementById('booking-data').textContent = JSON.stringify(data);
    app.replaceChildren();
    runBooking();
  }

  function el(tag, cls, text){ var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function money(c){ return new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR', minimumFractionDigits: c % 100 ? 2 : 0 }).format(c / 100); }
  function when(iso){ var d = new Date(iso); return new Intl.DateTimeFormat('pt-PT', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(d) + ', ' + new Intl.DateTimeFormat('pt-PT', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d); }

  function renderPay(){
    var panel = document.getElementById('pay-panel'), side = document.getElementById('pay-summary');
    if (!last) { location.hash = '#marcar'; return; }
    var svc = data.services.find(function(s){ return s.id === last.service; });
    var staffName = last.staff ? (data.staff.find(function(s){ return s.id === last.staff; }) || {}).name : 'Primeiro terapeuta livre';
    side.replaceChildren(el('p', null, svc.name), el('p', null, when(last.start)), el('p', null, 'Com ' + staffName), el('p', 'muted', 'Código DEMO42'));
    function ticket(){
      var t = el('article', 'ticket'); t.setAttribute('data-status', 'confirmed');
      t.appendChild(el('h1', null, 'Está marcado.'));
      var dl = el('dl', 'ticket-facts');
      [['Tratamento', svc.name + ', ' + svc.duration + ' min'], ['Quando', when(last.start)], ['Com', staffName],
       ['Pago', last.payment === 'studio' || last.payment === 'none' ? '0 €' : svc.dueLabel],
       ['A pagar no dia', money(svc.price - (last.payment === 'studio' || last.payment === 'none' ? 0 : svc.due))], ['Código', 'DEMO42']]
        .forEach(function(r){ var d = el('div'); d.append(el('dt', null, r[0]), el('dd', null, r[1])); dl.appendChild(d); });
      t.appendChild(dl);
      t.appendChild(el('p', 'muted', 'O cliente recebe esta confirmação por WhatsApp ou SMS, com um link para cancelar até 24 h antes, e um lembrete na véspera.'));
      panel.replaceChildren(t);
    }
    if (last.payment === 'studio' || last.payment === 'none') { ticket(); return; }
    if (last.payment === 'multibanco') {
      var ref = el('dl', 'mb-ref');
      [['Entidade', '12345'], ['Referência', '987 654 321'], ['Valor', svc.dueLabel]].forEach(function(r){ var d = el('div'); d.append(el('dt', null, r[0]), el('dd', null, r[1])); ref.appendChild(d); });
      var b = el('button', 'btn', 'Simular pagamento'); b.type = 'button'; b.onclick = ticket;
      panel.replaceChildren(el('h1', null, 'Pague com a referência Multibanco'), ref, el('p', null, 'O horário fica reservado durante 24 horas. Assim que o pagamento entra, a marcação fica confirmada.'), b);
      return;
    }
    var title = last.payment === 'card' ? 'A confirmar o pagamento…' : 'Aprove o pagamento no MB WAY';
    var body = last.payment === 'card' ? 'Na versão real, o cliente paga numa página segura do banco.' : 'Enviámos um pedido de ' + svc.dueLabel + ' para ' + (last.mbway_phone || last.phone) + '. Na versão real, o cliente aprova na app MB WAY.';
    var st = el('p', 'pay-status'); var sp = el('span', 'spinner'); st.append(sp, ' À espera da aprovação…');
    panel.replaceChildren(el('h1', null, title), el('p', null, body), st);
    setTimeout(ticket, 3500);
  }

  function show(){
    var v = (location.hash || '#inicio').slice(1);
    if (['inicio','marcar','pagar','dono'].indexOf(v) < 0) v = 'inicio';
    document.querySelectorAll('.view').forEach(function(n){ n.hidden = n.id !== 'v-' + v; });
    if (v === 'pagar') renderPay();
    if (v === 'marcar' && !app.childElementCount) startBooking(pendingPreset);
    pendingPreset = null;
    window.scrollTo(0, 0);
  }
  var pendingPreset = null;
  document.addEventListener('click', function(e){
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    if (a.dataset.preset) {
      var q = new URLSearchParams(a.dataset.preset.replace(/&amp;/g, '&'));
      e.preventDefault();
      startBooking({ service: q.get('servico'), date: q.get('data'), time: q.get('hora') });
      location.hash = '#marcar';
      return;
    }
    if (a.getAttribute('href') === '#marcar' && location.hash === '#marcar') { e.preventDefault(); startBooking({}); }
    if (a.dataset.scroll) {
      e.preventDefault();
      if (location.hash !== '#inicio') { location.hash = '#inicio'; }
      setTimeout(function(){ var t = document.getElementById(a.dataset.scroll); if (t) t.scrollIntoView(); }, 30);
    }
  });
  window.addEventListener('hashchange', show);
  show();
})();
</script>`;

  await mkdir(dirname(out), { recursive: true });
  // Inserted after templating so backslashes in the script survive untouched.
  await writeFile(out, page.replace('__BOOKING_JS__', () => bookingJs));
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, 'owner-img': { type: 'string', multiple: true } } });
  try {
    const out = values.out ?? join(root, 'demo-export', 'mare.html');
    await exportDemo(out, values['owner-img'] ?? []);
    console.log(`Wrote ${out}`);
  } finally {
    await closeDb();
    void sql;
  }
}
