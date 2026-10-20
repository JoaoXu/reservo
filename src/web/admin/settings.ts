// Studio settings: site content, look, booking rules, payments, alerts.
import { sql } from '../../db.ts';
import { config } from '../../config.ts';
import { html, type SafeHtml } from '../../lib/html.ts';
import { FieldErrors, email as emailField, hexColor, httpUrl, int, oneOf, phone as phoneField, str, bool } from '../../lib/validate.ts';
import { HttpError, htmlReply, readBody, redirect, type Ctx, type Reply } from '../../http/core.ts';
import { invalidateTenantCache, paymentKeys, sealPaymentKeys, type TenantContent, type TenantTheme } from '../../domain/tenants.ts';
import { adminPage, csrfField, fieldError, flashFrom, tr } from './layout.ts';

const SECTIONS = ['studio', 'look', 'booking', 'payments', 'alerts'] as const;
type Section = (typeof SECTIONS)[number];

function sectionNav(ctx: Ctx, current: Section): SafeHtml {
  const l = ctx.locale;
  const names: Record<Section, [string, string]> = {
    studio: ['Estúdio e textos', 'Studio and texts'], look: ['Aspeto', 'Look'], booking: ['Regras de marcação', 'Booking rules'],
    payments: ['Pagamentos', 'Payments'], alerts: ['Avisos', 'Alerts'],
  };
  return html`<nav class="tabs" aria-label="${tr(l, 'Secções', 'Sections')}">${SECTIONS.map((s) => html`<a href="/admin/settings?s=${s}" ${s === current ? html`aria-current="page"` : ''}>${tr(l, names[s][0], names[s][1])}</a>`)}</nav>`;
}

export async function settingsPage(ctx: Ctx, errors: Record<string, string> = {}): Promise<Reply> {
  const t = ctx.tenant!;
  const l = ctx.locale;
  const section = (SECTIONS as readonly string[]).includes(ctx.query.get('s') ?? '') ? (ctx.query.get('s') as Section) : 'studio';
  const c = t.content;
  const th = t.theme;
  let form: SafeHtml;

  if (section === 'studio') {
    form = html`
    <label>${tr(l, 'Nome do estúdio', 'Studio name')}<input name="name" value="${t.name}" required maxlength="80">${fieldError(errors, 'name', l)}</label>
    <div class="row">
      <label>${tr(l, 'Frase principal (português)', 'Headline (Portuguese)')}<input name="tagline_pt" value="${c.tagline_pt ?? ''}" maxlength="90"></label>
      <label>${tr(l, 'Frase principal (inglês)', 'Headline (English)')}<input name="tagline_en" value="${c.tagline_en ?? ''}" maxlength="90"></label>
    </div>
    <label>${tr(l, 'Introdução (português)', 'Intro (Portuguese)')}<textarea name="intro_pt" rows="2" maxlength="300">${c.intro_pt ?? ''}</textarea></label>
    <label>${tr(l, 'Introdução (inglês)', 'Intro (English)')}<textarea name="intro_en" rows="2" maxlength="300">${c.intro_en ?? ''}</textarea></label>
    <label>${tr(l, 'Sobre nós (português)', 'About us (Portuguese)')}<textarea name="about_pt" rows="4" maxlength="2000">${c.about_pt ?? ''}</textarea></label>
    <label>${tr(l, 'Sobre nós (inglês)', 'About us (English)')}<textarea name="about_en" rows="4" maxlength="2000">${c.about_en ?? ''}</textarea></label>
    <div class="row">
      <label>${tr(l, 'Morada', 'Address')}<input name="address" value="${c.address ?? ''}" maxlength="120"></label>
      <label>${tr(l, 'Código postal', 'Postcode')}<input name="postal_code" value="${c.postal_code ?? ''}" maxlength="12"></label>
      <label>${tr(l, 'Localidade', 'Town')}<input name="city" value="${c.city ?? ''}" maxlength="60"></label>
    </div>
    <label>${tr(l, 'Link do Google Maps', 'Google Maps link')}<input name="map_url" type="url" value="${c.map_url ?? ''}">${fieldError(errors, 'map_url', l)}</label>
    <div class="row">
      <label>${tr(l, 'Telefone', 'Phone')}<input name="phone" value="${c.phone ?? ''}" maxlength="30"></label>
      <label>WhatsApp<input name="whatsapp" value="${c.whatsapp ?? ''}" maxlength="30">${fieldError(errors, 'whatsapp', l)}</label>
      <label>Email<input name="email" type="email" value="${c.email ?? ''}">${fieldError(errors, 'email', l)}</label>
      <label>Instagram<input name="instagram" value="${c.instagram ?? ''}" maxlength="40" placeholder="@"></label>
    </div>
    <div class="row">
      <label>${tr(l, 'Nota sobre horário (português)', 'Hours note (Portuguese)')}<input name="hours_note_pt" value="${c.hours_note_pt ?? ''}" maxlength="120"></label>
      <label>${tr(l, 'Nota sobre horário (inglês)', 'Hours note (English)')}<input name="hours_note_en" value="${c.hours_note_en ?? ''}" maxlength="120"></label>
    </div>
    <div class="row">
      <label>${tr(l, 'Nome legal (para o rodapé e privacidade)', 'Legal name (footer and privacy)')}<input name="legal_name" value="${c.legal_name ?? ''}" maxlength="120"></label>
      <label>NIF<input name="nif" value="${c.nif ?? ''}" maxlength="12" inputmode="numeric"></label>
    </div>
    <label>${tr(l, 'Política de cancelamento (português, opcional)', 'Cancellation policy (Portuguese, optional)')}<textarea name="policy_pt" rows="3" maxlength="2000">${c.policy_pt ?? ''}</textarea></label>
    <label>${tr(l, 'Política de cancelamento (inglês, opcional)', 'Cancellation policy (English, optional)')}<textarea name="policy_en" rows="3" maxlength="2000">${c.policy_en ?? ''}</textarea></label>`;
  } else if (section === 'look') {
    form = html`
    <p class="muted">${tr(l, 'As cores aplicam-se ao site e ao painel. Garanta bom contraste entre texto e fundo.', 'Colours apply to the site and dashboard. Keep good contrast between text and background.')}</p>
    <div class="row">
      <label>${tr(l, 'Texto e botões', 'Text and buttons')}<input type="color" name="ink" value="${th.ink ?? '#1d3a35'}"></label>
      <label>${tr(l, 'Fundo', 'Background')}<input type="color" name="paper" value="${th.paper ?? '#eef2ee'}"></label>
      <label>${tr(l, 'Destaque', 'Highlight')}<input type="color" name="accent" value="${th.accent ?? '#7a4e63'}"></label>
      <label>${tr(l, 'Superfícies', 'Surfaces')}<input type="color" name="soft" value="${th.soft ?? '#dfe7e1'}"></label>
    </div>${fieldError(errors, 'colors', l)}
    <label>${tr(l, 'Logótipo (link https, opcional)', 'Logo (https link, optional)')}<input name="logo_url" type="url" value="${th.logo_url ?? ''}">${fieldError(errors, 'logo_url', l)}</label>`;
  } else if (section === 'booking') {
    form = html`
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
  ${section === 'studio' ? html`<p class="muted"><a href="/admin/customers">${tr(l, 'Clientes e dados pessoais', 'Customers and personal data')}</a> · <a href="/admin/account">${tr(l, 'A sua conta', 'Your account')}</a></p>` : ''}`;
  return htmlReply(adminPage(ctx, { title: tr(l, 'Definições', 'Settings'), body, flash: flashFrom(ctx) }), Object.keys(errors).length ? 422 : 200);
}

export async function settingsSave(ctx: Ctx): Promise<Reply> {
  const t = ctx.tenant!;
  const section = ctx.query.get('s') as Section;
  if (!(SECTIONS as readonly string[]).includes(section)) throw new HttpError(400, 'Unknown section');
  const body = await readBody(ctx);
  const errs = new FieldErrors();

  if (section === 'studio') {
    const name = str(body, 'name', errs, { max: 80 });
    const content: TenantContent = { ...t.content };
    for (const [k, max] of [['tagline_pt', 90], ['tagline_en', 90], ['intro_pt', 300], ['intro_en', 300], ['about_pt', 2000], ['about_en', 2000],
      ['address', 120], ['postal_code', 12], ['city', 60], ['phone', 30], ['instagram', 40], ['hours_note_pt', 120], ['hours_note_en', 120],
      ['legal_name', 120], ['nif', 12], ['policy_pt', 2000], ['policy_en', 2000]] as const) {
      (content as Record<string, string>)[k] = str(body, k, errs, { max, required: false });
    }
    content.map_url = httpUrl(body, 'map_url', errs) ?? '';
    content.email = emailField(body, 'email', errs, false) ?? '';
    content.whatsapp = str(body, 'whatsapp', errs, { max: 30, required: false }) ? phoneField(body, 'whatsapp', errs, false) : '';
    if (!errs.ok) return settingsPage(ctx, errs.errors);
    await sql`update tenants set name = ${name}, content = ${sql.json(content as never)}, updated_at = now() where id = ${t.id}`;
  } else if (section === 'look') {
    const theme: TenantTheme = {
      ...t.theme,
      ink: hexColor(body, 'ink', errs, '#1d3a35'), paper: hexColor(body, 'paper', errs, '#eef2ee'),
      accent: hexColor(body, 'accent', errs, '#7a4e63'), soft: hexColor(body, 'soft', errs, '#dfe7e1'),
      logo_url: httpUrl(body, 'logo_url', errs) ?? '',
    };
    if (!errs.ok) return settingsPage(ctx, errs.errors);
    await sql`update tenants set theme = ${sql.json(theme as never)}, updated_at = now() where id = ${t.id}`;
  } else if (section === 'booking') {
    const v = {
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
