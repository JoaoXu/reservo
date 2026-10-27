// Studio settings: business type, booking rules, payments, alerts.
// Site texts and look are versioned and live in ./site.ts.
import { sql } from '../../db.ts';
import { config } from '../../config.ts';
import { html, type SafeHtml } from '../../lib/html.ts';
import { FieldErrors, email as emailField, int, oneOf, phone as phoneField, str, bool } from '../../lib/validate.ts';
import { HttpError, htmlReply, readBody, redirect, type Ctx, type Reply } from '../../http/core.ts';
import { BUSINESS_TYPES, invalidateTenantCache, paymentKeys, sealPaymentKeys, type BusinessType } from '../../domain/tenants.ts';
import { adminPage, csrfField, fieldError, flashFrom, tr } from './layout.ts';

const SECTIONS = ['booking', 'payments', 'alerts'] as const;
type Section = (typeof SECTIONS)[number];

function sectionNav(ctx: Ctx, current: Section): SafeHtml {
  const l = ctx.locale;
  const names: Record<Section, [string, string]> = {
    booking: ['Negócio e marcações', 'Business and bookings'],
    payments: ['Pagamentos', 'Payments'], alerts: ['Avisos', 'Alerts'],
  };
  return html`<nav class="tabs" aria-label="${tr(l, 'Secções', 'Sections')}">${SECTIONS.map((s) => html`<a href="/admin/settings?s=${s}" ${s === current ? html`aria-current="page"` : ''}>${tr(l, names[s][0], names[s][1])}</a>`)}</nav>`;
}

const BUSINESS_NAMES: Record<BusinessType, [string, string]> = {
  massage: ['Massagem e bem-estar', 'Massage and wellness'], salon: ['Cabeleireiro', 'Hair salon'],
  barber: ['Barbearia', 'Barbershop'], beauty: ['Estética e unhas', 'Beauty and nails'],
};

export async function settingsPage(ctx: Ctx, errors: Record<string, string> = {}): Promise<Reply> {
  const t = ctx.tenant!;
  const l = ctx.locale;
  // Texts and look moved to the Website page; keep old links working.
  const asked = ctx.query.get('s');
  if (asked === 'studio' || asked === 'look') return redirect(`/admin/site?s=${asked === 'studio' ? 'texts' : 'look'}`);
  const section = (SECTIONS as readonly string[]).includes(asked ?? '') ? (asked as Section) : 'booking';
  let form: SafeHtml;

  if (section === 'booking') {
    form = html`
    <label>${tr(l, 'Tipo de negócio', 'Type of business')}<select name="business_type">${BUSINESS_TYPES.map((b) => html`<option value="${b}" ${t.business_type === b ? 'selected' : ''}>${tr(l, BUSINESS_NAMES[b][0], BUSINESS_NAMES[b][1])}</option>`)}</select>
      <small>${tr(l, 'Define as palavras usadas no site e na marcação (por exemplo “Terapeuta” ou “Barbeiro”).', 'Sets the words used on the site and in booking (for example “Therapist” or “Barber”).')}</small></label>
    <div class="row">
      <label>${tr(l, 'Intervalo entre horários (min)', 'Time between start options (min)')}<select name="slot_interval_min">${[10, 15, 20, 30, 60].map((n) => html`<option value="${n}" ${t.slot_interval_min === n ? 'selected' : ''}>${n}</option>`)}</select></label>
      <label>${tr(l, 'Antecedência mínima (horas)', 'Minimum notice (hours)')}<input type="number" name="min_lead_hours" min="0" max="72" value="${Math.round(t.min_lead_min / 60)}"></label>
      <label>${tr(l, 'Marcar até (dias)', 'Book up to (days ahead)')}<input type="number" name="max_advance_days" min="1" max="365" value="${t.max_advance_days}"></label>
      <label>${tr(l, 'Cancelamento grátis até (horas antes)', 'Free cancellation until (hours before)')}<input type="number" name="cancel_window_hours" min="0" max="168" value="${t.cancel_window_hours}"></label>
    </div>
    <label>${tr(l, 'Idioma principal do site', 'Main site language')}<select name="default_locale"><option value="pt" ${t.default_locale === 'pt' ? 'selected' : ''}>Português</option><option value="en" ${t.default_locale === 'en' ? 'selected' : ''}>English</option></select></label>`;
  } else if (section === 'payments') {
    const keys = paymentKeys(t);
    const base = config.publicBaseUrl.replace(/\/$/, '');
    const cb = `${base}/hooks/ifthenpay/${t.id}?key=[ANTI_PHISHING_KEY]&orderId=[ORDER_ID]&amount=[AMOUNT]&requestId=[REQUEST_ID]&payment_datetime=[PAYMENT_DATETIME]`;
    const cbCard = `${base}/hooks/ifthenpay/${t.id}?key=[ANTI_PHISHING_KEY]&id=[ORDER_ID]&amount=[AMOUNT]&payment_datetime=[PAYMENT_DATETIME]&payment_method=[PAYMENT_METHOD]`;
    const set = (k?: string) => (k ? tr(l, 'definida (deixe vazio para manter)', 'set (leave blank to keep)') : tr(l, 'não definida', 'not set'));
    form = html`
    <label>${tr(l, 'Pagamento online', 'Online payment')}
      <select name="payment_mode">
        <option value="none" ${t.payment_mode === 'none' ? 'selected' : ''}>${tr(l, 'Não pedir pagamento online', 'Don’t ask for online payment')}</option>
        <option value="deposit" ${t.payment_mode === 'deposit' ? 'selected' : ''}>${tr(l, 'Pedir um sinal', 'Ask for a deposit')}</option>
        <option value="full" ${t.payment_mode === 'full' ? 'selected' : ''}>${tr(l, 'Pagamento total ao marcar', 'Full payment when booking')}</option>
      </select></label>
    <div class="row">
      <label>${tr(l, 'Sinal (%)', 'Deposit (%)')}<input type="number" name="deposit_percent" min="1" max="100" value="${t.deposit_percent}"></label>
      <label>${tr(l, 'Prazo MB WAY (min)', 'MB WAY window (min)')}<input type="number" name="mbway_hold_min" min="5" max="60" value="${t.mbway_hold_min}"></label>
      <label>${tr(l, 'Prazo Multibanco (horas)', 'Multibanco window (hours)')}<input type="number" name="multibanco_hold_hours" min="1" max="168" value="${t.multibanco_hold_hours}"></label>
    </div>
    <label class="check"><input type="checkbox" name="pay_at_studio_allowed" ${t.pay_at_studio_allowed ? 'checked' : ''}> ${tr(l, 'Deixar os clientes escolher pagar no dia', 'Let customers choose to pay on the day')}</label>
    <fieldset><legend>ifthenpay</legend>
      <p class="muted">${tr(l, 'O dinheiro vai diretamente para a conta do estúdio na ifthenpay. As chaves são guardadas encriptadas.', 'Money goes straight to the studio’s ifthenpay account. Keys are stored encrypted.')}</p>
      <label>${tr(l, 'Fornecedor', 'Provider')}<select name="payment_provider">
        <option value="none" ${t.payment_provider === 'none' ? 'selected' : ''}>${tr(l, 'Nenhum', 'None')}</option>
        <option value="ifthenpay" ${t.payment_provider === 'ifthenpay' ? 'selected' : ''}>ifthenpay</option>
        ${t.status === 'demo' || config.allowMockPayments ? html`<option value="mock" ${t.payment_provider === 'mock' ? 'selected' : ''}>${tr(l, 'Simulado (demonstração)', 'Simulated (demo)')}</option>` : ''}
      </select></label>
      <div class="row">
        <label>${tr(l, 'Chave MB WAY', 'MB WAY key')} <small>${set(keys.mbwayKey)}</small><input name="mbwayKey" autocomplete="off" maxlength="40"></label>
        <label>${tr(l, 'Chave Multibanco (MB KEY)', 'Multibanco key (MB KEY)')} <small>${set(keys.mbKey)}</small><input name="mbKey" autocomplete="off" maxlength="40"></label>
        <label>${tr(l, 'Chave cartão (CCARD KEY)', 'Card key (CCARD KEY)')} <small>${set(keys.ccardKey)}</small><input name="ccardKey" autocomplete="off" maxlength="40"></label>
        <label>${tr(l, 'Chave anti-phishing', 'Anti-phishing key')} <small>${set(keys.antiPhishingKey)}</small><input name="antiPhishingKey" autocomplete="off" maxlength="50"></label>
      </div>
      <p>${tr(l, 'Peça à ifthenpay para ativar o callback com este URL (MB WAY e Multibanco):', 'Ask ifthenpay to activate the callback with this URL (MB WAY and Multibanco):')}</p>
      <pre class="copy">${cb}</pre>
      <p>${tr(l, 'Para cartão:', 'For cards:')}</p>
      <pre class="copy">${cbCard}</pre>
    </fieldset>`;
  } else {
    form = html`
    <p class="muted">${tr(l, 'Recebe um email a cada nova marcação e cancelamento.', 'Get an email for every new booking and cancellation.')}</p>
    <label>${tr(l, 'Email para avisos', 'Email for alerts')}<input type="email" name="notify_owner_email" value="${t.notify_owner_email ?? ''}">${fieldError(errors, 'notify_owner_email', l)}</label>
    <label>${tr(l, 'Telemóvel para avisos (opcional)', 'Mobile for alerts (optional)')}<input name="notify_owner_phone" value="${t.notify_owner_phone ?? ''}">${fieldError(errors, 'notify_owner_phone', l)}</label>`;
  }

  const body = html`<h1>${tr(l, 'Definições', 'Settings')}</h1>
  ${sectionNav(ctx, section)}
  <form method="post" action="/admin/settings?s=${section}" class="form">${csrfField(ctx)}
    ${form}
    <button class="btn" type="submit">${tr(l, 'Guardar', 'Save')}</button>
  </form>
  ${section === 'booking' ? html`<p class="muted"><a href="/admin/site">${tr(l, 'Textos e aspeto do site', 'Website texts and look')}</a> · <a href="/admin/customers">${tr(l, 'Clientes e dados pessoais', 'Customers and personal data')}</a> · <a href="/admin/account">${tr(l, 'A sua conta', 'Your account')}</a></p>` : ''}`;
  return htmlReply(adminPage(ctx, { title: tr(l, 'Definições', 'Settings'), body, flash: flashFrom(ctx) }), Object.keys(errors).length ? 422 : 200);
}

export async function settingsSave(ctx: Ctx): Promise<Reply> {
  const t = ctx.tenant!;
  const section = ctx.query.get('s') as Section;
  if (!(SECTIONS as readonly string[]).includes(section)) throw new HttpError(400, 'Unknown section');
  const body = await readBody(ctx);
  const errs = new FieldErrors();

  if (section === 'booking') {
    const v = {
      business_type: oneOf(body, 'business_type', BUSINESS_TYPES, errs, t.business_type),
      slot_interval_min: int(body, 'slot_interval_min', errs, { min: 5, max: 120 }),
      min_lead_min: int(body, 'min_lead_hours', errs, { min: 0, max: 72 }) * 60,
      max_advance_days: int(body, 'max_advance_days', errs, { min: 1, max: 365 }),
      cancel_window_hours: int(body, 'cancel_window_hours', errs, { min: 0, max: 168 }),
      default_locale: oneOf(body, 'default_locale', ['pt', 'en'] as const, errs, 'pt'),
    };
    if (!errs.ok) return settingsPage(ctx, errs.errors);
    await sql`update tenants set ${sql(v)}, updated_at = now() where id = ${t.id}`;
  } else if (section === 'payments') {
    const providers = t.status === 'demo' || config.allowMockPayments ? (['none', 'ifthenpay', 'mock'] as const) : (['none', 'ifthenpay'] as const);
    const v = {
      payment_mode: oneOf(body, 'payment_mode', ['none', 'deposit', 'full'] as const, errs),
      deposit_percent: int(body, 'deposit_percent', errs, { min: 1, max: 100 }),
      mbway_hold_min: int(body, 'mbway_hold_min', errs, { min: 5, max: 60 }),
      multibanco_hold_hours: int(body, 'multibanco_hold_hours', errs, { min: 1, max: 168 }),
      pay_at_studio_allowed: bool(body, 'pay_at_studio_allowed'),
      payment_provider: oneOf(body, 'payment_provider', providers as readonly string[], errs, 'none') as 'none' | 'ifthenpay' | 'mock',
    };
    const keys = paymentKeys(t);
    for (const k of ['mbwayKey', 'mbKey', 'ccardKey', 'antiPhishingKey'] as const) {
      const val = str(body, k, errs, { max: 50, required: false });
      if (val) keys[k] = val; // blank keeps the stored key
    }
    if (!errs.ok) return settingsPage(ctx, errs.errors);
    await sql`update tenants set ${sql(v)}, payment_secrets = ${sealPaymentKeys(keys)}, updated_at = now() where id = ${t.id}`;
    await sql`insert into audit_log (tenant_id, user_id, action, details) values (${t.id}, ${ctx.session!.userId}, 'settings.payments', ${sql.json({ provider: v.payment_provider, mode: v.payment_mode })})`;
  } else {
    const ownerEmail = emailField(body, 'notify_owner_email', errs, false);
    const ownerPhone = str(body, 'notify_owner_phone', errs, { max: 30, required: false }) ? phoneField(body, 'notify_owner_phone', errs, false) : null;
    if (!errs.ok) return settingsPage(ctx, errs.errors);
    await sql`update tenants set notify_owner_email = ${ownerEmail}, notify_owner_phone = ${ownerPhone || null}, updated_at = now() where id = ${t.id}`;
  }
  invalidateTenantCache();
  return redirect(`/admin/settings?s=${section}&ok=saved`);
}
