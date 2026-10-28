// The public website: texts, look and sections are edited as a draft, then
// previewed, published, or rolled back to an earlier version. Owner only.
import { html, raw, type SafeHtml } from '../../lib/html.ts';
import { tb } from '../../lib/i18n.ts';
import { FieldErrors, email as emailField, hexColor, httpUrl, isUuid, phone as phoneField, str, bool } from '../../lib/validate.ts';
import { HttpError, htmlReply, readBody, redirect, type Ctx, type Reply } from '../../http/core.ts';
import { SECTION_TYPES, type SectionType, type TenantContent } from '../../domain/tenants.ts';
import {
  LIMITS, discardDraft, draftVersion, listVersions, normalizeSite, publishDraft, publishedVersion, restoreVersion, saveDraft, withVersion,
  type SiteVersion,
} from '../../domain/sites.ts';
import { FONTS, FONT_INFO, PALETTES, TEMPLATES, TEMPLATE_INFO, contrastProblems, type Font, type Template } from '../../domain/design.ts';
import { siteFont } from '../layout.ts';
import { adminPage, csrfField, fieldError, flashFrom, tr } from './layout.ts';

const TABS = ['texts', 'look', 'sections', 'gallery', 'testimonials', 'faq', 'history'] as const;
const EDITABLE = ['texts', 'look', 'sections', 'gallery', 'testimonials', 'faq'];
type Tab = (typeof TABS)[number];

function sectionName(type: SectionType, ctx: Ctx): string {
  const l = ctx.locale;
  const names: Record<SectionType, [string, string]> = {
    hero: ['Destaque (topo da página)', 'Hero (top of the page)'],
    services: [tb('pt', ctx.tenant!.business_type, 'services.title'), tb('en', ctx.tenant!.business_type, 'services.title')],
    about: ['Sobre nós', 'About us'],
    team: ['Equipa', 'Team'],
    gallery: ['Galeria', 'Gallery'],
    testimonials: ['Testemunhos', 'Testimonials'],
    faq: ['Perguntas frequentes', 'FAQ'],
    visit: ['Morada e horário', 'Address and hours'],
  };
  return tr(l, names[type][0], names[type][1]);
}

function draftBar(ctx: Ctx, draft: SiteVersion | null, published: SiteVersion | null): SafeHtml {
  const l = ctx.locale;
  if (!draft) {
    return html`<p class="site-status muted">${tr(l, 'Publicado', 'Published')}${published ? html`: ${tr(l, 'versão', 'version')} ${published.number}` : ''}. ${tr(l, 'As alterações ficam num rascunho até as publicar.', 'Changes go into a draft until you publish them.')}</p>`;
  }
  return html`<div class="site-status draft" role="status">
    <p><strong>${tr(l, 'Rascunho por publicar', 'Unpublished draft')}</strong> (${tr(l, 'versão', 'version')} ${draft.number}). ${tr(l, 'O site público ainda mostra a versão publicada.', 'The public site still shows the published version.')}</p>
    <div class="site-actions">
      <a class="btn btn-quiet btn-small" href="/?preview=1" target="_blank" rel="noopener">${tr(l, 'Pré-visualizar', 'Preview')}</a>
      <form method="post" action="/admin/site/publish" class="inline">${csrfField(ctx)}<button class="btn btn-small" type="submit">${tr(l, 'Publicar', 'Publish')}</button></form>
      <form method="post" action="/admin/site/discard" class="inline">${csrfField(ctx)}<button class="btn btn-danger btn-small" type="submit">${tr(l, 'Descartar rascunho', 'Discard draft')}</button></form>
    </div>
  </div>`;
}

export async function siteAdminPage(ctx: Ctx, errors: Record<string, string> = {}, values?: Record<string, unknown>): Promise<Reply> {
  const l = ctx.locale;
  const tab = (TABS as readonly string[]).includes(ctx.query.get('s') ?? '') ? (ctx.query.get('s') as Tab) : 'texts';
  const [draft, published] = await Promise.all([draftVersion(ctx.tenant!.id), publishedVersion(ctx.tenant!.id)]);
  // Forms show the draft if there is one, otherwise what's live.
  const t = draft ? withVersion(ctx.tenant!, draft) : ctx.tenant!;
  const c = { ...t.content, ...(values ?? {}) } as TenantContent & Record<string, string>;
  const th = t.theme;
  let content: SafeHtml;

  if (tab === 'texts') {
    content = html`<form method="post" action="/admin/site?s=texts" class="form">${csrfField(ctx)}
    <label>${tr(l, 'Nome do negócio', 'Business name')}<input name="name" value="${String(values?.name ?? t.name)}" required maxlength="80">${fieldError(errors, 'name', l)}</label>
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
    <label>${tr(l, 'Política de cancelamento (inglês, opcional)', 'Cancellation policy (English, optional)')}<textarea name="policy_en" rows="3" maxlength="2000">${c.policy_en ?? ''}</textarea></label>
    <button class="btn" type="submit">${tr(l, 'Guardar no rascunho', 'Save to draft')}</button>
    </form>`;
  } else if (tab === 'look') {
    const site = normalizeSite(t.site);
    const font = siteFont(t);
    // Re-shown after rejected custom colours: keep "custom" selected with what they typed.
    const palette = values ? 'custom' : th.palette && (th.palette === 'custom' || PALETTES[th.palette]) ? th.palette : 'custom';
    // Swatch colours go in a nonce'd style block: the CSP forbids style="".
    const swatches = Object.entries(PALETTES).map(([k, p]) => `.sw-${k} i:nth-child(1){background:${p.ink}}.sw-${k} i:nth-child(2){background:${p.paper}}.sw-${k} i:nth-child(3){background:${p.accent}}.sw-${k} i:nth-child(4){background:${p.soft}}`).join('');
    const v = (k: 'ink' | 'paper' | 'accent' | 'soft', d: string) => String(values?.[k] ?? th[k] ?? d);
    content = html`${raw(`<style nonce="${ctx.nonce}">${swatches}</style>`)}<form method="post" action="/admin/site?s=look" class="form">${csrfField(ctx)}
    <fieldset><legend>${tr(l, 'Modelo', 'Template')}</legend>
      ${TEMPLATES.map((k) => html`<label class="check choice"><input type="radio" name="template" value="${k}" ${site.template === k ? 'checked' : ''}>
        <span><strong>${tr(l, TEMPLATE_INFO[k].pt, TEMPLATE_INFO[k].en)}</strong><br><small>${tr(l, TEMPLATE_INFO[k].hint_pt, TEMPLATE_INFO[k].hint_en)}</small></span></label>`)}
    </fieldset>
    <fieldset><legend>${tr(l, 'Letra', 'Font')}</legend>
      ${FONTS.map((k) => html`<label class="check"><input type="radio" name="font" value="${k}" ${font === k ? 'checked' : ''}> ${tr(l, FONT_INFO[k].pt, FONT_INFO[k].en)}</label>`)}
    </fieldset>
    <fieldset><legend>${tr(l, 'Cores', 'Colours')}</legend>
      <div class="palettes">${Object.entries(PALETTES).map(([k, p]) => html`<label class="check choice palette sw-${k}"><input type="radio" name="palette" value="${k}" ${palette === k ? 'checked' : ''}>
        <span class="swatch" aria-hidden="true"><i></i><i></i><i></i><i></i></span> ${tr(l, p.pt, p.en)}</label>`)}
        <label class="check choice palette"><input type="radio" name="palette" value="custom" ${palette === 'custom' ? 'checked' : ''}> ${tr(l, 'Personalizadas (abaixo)', 'Custom (below)')}</label>
      </div>
      <div class="row">
        <label>${tr(l, 'Texto e botões', 'Text and buttons')}<input type="color" name="ink" value="${v('ink', '#1d3a35')}"></label>
        <label>${tr(l, 'Fundo', 'Background')}<input type="color" name="paper" value="${v('paper', '#eef2ee')}"></label>
        <label>${tr(l, 'Destaque', 'Highlight')}<input type="color" name="accent" value="${v('accent', '#7a4e63')}"></label>
        <label>${tr(l, 'Superfícies', 'Surfaces')}<input type="color" name="soft" value="${v('soft', '#dfe7e1')}"></label>
      </div>
      <small>${tr(l, 'As cores personalizadas só são aceites se o texto se ler bem (contraste de pelo menos 4,5:1).', 'Custom colours are accepted only if text stays readable (contrast of at least 4.5:1).')}</small>
      ${errors.colors ? html`<span class="field-error" role="alert">${errors.colors}</span>` : ''}
    </fieldset>
    <label>${tr(l, 'Logótipo (link https, opcional)', 'Logo (https link, optional)')}<input name="logo_url" type="url" value="${th.logo_url ?? ''}">${fieldError(errors, 'logo_url', l)}</label>
    <button class="btn" type="submit">${tr(l, 'Guardar no rascunho', 'Save to draft')}</button>
    </form>`;
  } else if (tab === 'sections') {
    const site = normalizeSite(t.site);
    content = html`<form method="post" action="/admin/site?s=sections" class="form">${csrfField(ctx)}
    <p class="muted">${tr(l, 'Escolha que secções aparecem na página inicial e por que ordem.', 'Choose which sections appear on the home page, and in what order.')}</p>
    <table class="table">
      <thead><tr><th>${tr(l, 'Secção', 'Section')}</th><th>${tr(l, 'Mostrar', 'Show')}</th><th>${tr(l, 'Ordem', 'Order')}</th></tr></thead>
      <tbody>${site.sections.map((s, i) => html`<tr>
        <td>${sectionName(s.type, ctx)}</td>
        <td>${s.type === 'services'
          ? html`<span class="muted">${tr(l, 'Sempre (é por aqui que se marca)', 'Always (it’s how people book)')}</span>`
          : html`<label class="check"><input type="checkbox" name="show_${s.type}" ${s.enabled ? 'checked' : ''}> <span class="sr-only">${sectionName(s.type, ctx)}</span></label>`}</td>
        <td><input type="number" name="order_${s.type}" value="${i + 1}" min="1" max="${SECTION_TYPES.length}" class="order-input" aria-label="${tr(l, 'Ordem', 'Order')}: ${sectionName(s.type, ctx)}"></td>
      </tr>`)}</tbody>
    </table>
    <button class="btn" type="submit">${tr(l, 'Guardar no rascunho', 'Save to draft')}</button>
    </form>`;
  } else if (tab === 'gallery' || tab === 'testimonials' || tab === 'faq') {
    content = listEditor(ctx, tab, normalizeSite(t.site));
  } else {
    const versions = await listVersions(ctx.tenant!.id);
    const when = (d: Date) => new Intl.DateTimeFormat(l === 'en' ? 'en-GB' : 'pt-PT', { dateStyle: 'medium', timeStyle: 'short', timeZone: ctx.tenant!.timezone }).format(d);
    const label: Record<SiteVersion['status'], [string, string]> = { draft: ['Rascunho', 'Draft'], published: ['Publicada', 'Live'], archived: ['Anterior', 'Earlier'] };
    content = html`<table class="table">
      <thead><tr><th>${tr(l, 'Versão', 'Version')}</th><th>${tr(l, 'Estado', 'Status')}</th><th>${tr(l, 'Quando', 'When')}</th><th>${tr(l, 'Por', 'By')}</th><th></th></tr></thead>
      <tbody>${versions.map((v) => html`<tr>
        <td>${v.number}${v.note ? html`<br><small class="muted">${v.note}</small>` : ''}</td>
        <td>${tr(l, label[v.status][0], label[v.status][1])}</td>
        <td>${when(v.published_at ?? v.created_at)}</td>
        <td>${v.created_by}</td>
        <td>${v.status === 'archived' ? html`<form method="post" action="/admin/site/versions/${v.id}/restore" class="inline">${csrfField(ctx)}<button class="btn btn-quiet btn-small" type="submit">${tr(l, 'Repor e publicar', 'Restore and publish')}</button></form>` : ''}</td>
      </tr>`)}</tbody>
    </table>`;
  }

  const names: Record<Tab, [string, string]> = {
    texts: ['Textos', 'Texts'], look: ['Aspeto', 'Look'], sections: ['Secções', 'Sections'], gallery: ['Galeria', 'Gallery'],
    testimonials: ['Testemunhos', 'Testimonials'], faq: ['Perguntas', 'FAQ'], history: ['Histórico', 'History'],
  };
  const body = html`<h1>${tr(l, 'Site', 'Website')}</h1>
  ${draftBar(ctx, draft, published)}
  <nav class="tabs" aria-label="${tr(l, 'Secções', 'Sections')}">${TABS.map((s) => html`<a href="/admin/site?s=${s}" ${s === tab ? html`aria-current="page"` : ''}>${tr(l, names[s][0], names[s][1])}</a>`)}</nav>
  ${content}`;
  return htmlReply(adminPage(ctx, { title: tr(l, 'Site', 'Website'), body, flash: flashFrom(ctx) }), Object.keys(errors).length ? 422 : 200);
}

export async function siteSave(ctx: Ctx): Promise<Reply> {
  const tab = ctx.query.get('s') as Tab;
  if (!EDITABLE.includes(tab)) throw new HttpError(400, 'Unknown section');
  const body = await readBody(ctx);
  const errs = new FieldErrors();
  const by = ctx.session!.name;

  if (tab === 'texts') {
    const name = str(body, 'name', errs, { max: 80 });
    const content: Record<string, string> = {};
    for (const [k, max] of [['tagline_pt', 90], ['tagline_en', 90], ['intro_pt', 300], ['intro_en', 300], ['about_pt', 2000], ['about_en', 2000],
      ['address', 120], ['postal_code', 12], ['city', 60], ['phone', 30], ['instagram', 40], ['hours_note_pt', 120], ['hours_note_en', 120],
      ['legal_name', 120], ['nif', 12], ['policy_pt', 2000], ['policy_en', 2000]] as const) {
      content[k] = str(body, k, errs, { max, required: false });
    }
    content.map_url = httpUrl(body, 'map_url', errs) ?? '';
    content.email = emailField(body, 'email', errs, false) ?? '';
    content.whatsapp = str(body, 'whatsapp', errs, { max: 30, required: false }) ? phoneField(body, 'whatsapp', errs, false) : '';
    if (!errs.ok) return siteAdminPage(ctx, errs.errors, body);
    await saveDraft(ctx.tenant!.id, (cur) => ({ ...cur, name, content: { ...cur.content, ...content } }), by);
  } else if (tab === 'look') {
    const template = (TEMPLATES as readonly string[]).includes(String(body.template)) ? (body.template as Template) : 'classic';
    const font = (FONTS as readonly string[]).includes(String(body.font)) ? (body.font as Font) : TEMPLATE_INFO[template].font;
    const key = String(body.palette ?? 'custom');
    const preset = PALETTES[key];
    const colours = preset
      ? { ink: preset.ink, paper: preset.paper, accent: preset.accent, soft: preset.soft }
      : { ink: hexColor(body, 'ink', errs, '#1d3a35'), paper: hexColor(body, 'paper', errs, '#eef2ee'), accent: hexColor(body, 'accent', errs, '#7a4e63'), soft: hexColor(body, 'soft', errs, '#dfe7e1') };
    const logo_url = httpUrl(body, 'logo_url', errs) ?? '';
    if (!errs.ok) return siteAdminPage(ctx, errs.errors);
    const bad = contrastProblems(colours);
    if (bad.length) {
      const l = ctx.locale;
      const msg = bad.map(({ rule, ratio }) => `${tr(l, rule.pt, rule.en)} ${ratio.toFixed(1).replace('.', l === 'pt' ? ',' : '.')}:1`).join('; ');
      return siteAdminPage(ctx, { colors: tr(l, `Estas cores não se leem bem: ${msg}. O mínimo é 4,5:1.`, `These colours aren’t readable enough: ${msg}. The minimum is 4.5:1.`) }, colours);
    }
    await saveDraft(ctx.tenant!.id, (cur) => ({ ...cur, theme: { ...cur.theme, ...colours, palette: preset ? key : 'custom', font, logo_url }, site: { ...cur.site, template } }), by);
  } else if (tab === 'gallery' || tab === 'testimonials' || tab === 'faq') {
    const rows = readRows(body, tab);
    await saveDraft(ctx.tenant!.id, (cur) => ({ ...cur, site: { ...cur.site, [tab]: rows } }), by);
  } else {
    // Sections: sort by the typed order; ties keep the current order.
    const current = normalizeSite((await draftVersion(ctx.tenant!.id))?.site ?? ctx.tenant!.site).sections;
    const sections = current
      .map((s, i) => ({ type: s.type, enabled: s.type === 'services' || bool(body, `show_${s.type}`), order: Number(body[`order_${s.type}`]) || i + 1, i }))
      .sort((a, b) => a.order - b.order || a.i - b.i)
      .map(({ type, enabled }) => ({ type, enabled }));
    await saveDraft(ctx.tenant!.id, (cur) => ({ ...cur, site: { ...cur.site, sections } }), by);
  }
  return redirect(`/admin/site?s=${tab}&ok=draft`);
}

export async function sitePublish(ctx: Ctx): Promise<Reply> {
  const v = await publishDraft(ctx.tenant!.id, ctx.session!.userId);
  return redirect(`/admin/site?ok=${v ? 'published' : 'nodraft'}`);
}

export async function siteDiscard(ctx: Ctx): Promise<Reply> {
  await discardDraft(ctx.tenant!.id);
  return redirect('/admin/site?ok=discarded');
}

export async function siteRestore(ctx: Ctx): Promise<Reply> {
  const id = ctx.params.id;
  if (!isUuid(id)) throw new HttpError(404, 'Not found');
  const v = await restoreVersion(ctx.tenant!.id, id, ctx.session!.userId, ctx.session!.name);
  if (!v) throw new HttpError(404, 'Not found');
  return redirect('/admin/site?s=history&ok=restored');
}

// --- List editors (gallery, testimonials, FAQ) ----------------------------------
// Plain forms with numbered rows: existing items plus empty rows up to the
// limit. Clearing a row removes it; normalizeSite drops incomplete rows.

const LIST_FIELDS = {
  gallery: [['url', 'Link da imagem (https)', 'Image link (https)', 500], ['alt_pt', 'Descrição (português)', 'Description (Portuguese)', 140], ['alt_en', 'Descrição (inglês)', 'Description (English)', 140]],
  testimonials: [['quote_pt', 'Testemunho (português)', 'Quote (Portuguese)', 400], ['quote_en', 'Testemunho (inglês)', 'Quote (English)', 400], ['author', 'Nome', 'Name', 60]],
  faq: [['q_pt', 'Pergunta (português)', 'Question (Portuguese)', 160], ['a_pt', 'Resposta (português)', 'Answer (Portuguese)', 800], ['q_en', 'Pergunta (inglês)', 'Question (English)', 160], ['a_en', 'Resposta (inglês)', 'Answer (English)', 800]],
} as const;
type ListTab = keyof typeof LIST_FIELDS;

function listEditor(ctx: Ctx, tab: ListTab, site: ReturnType<typeof normalizeSite>): SafeHtml {
  const l = ctx.locale;
  const items = site[tab] as unknown as Record<string, string>[];
  const count = Math.min(LIMITS[tab], items.length + 2);
  const hint: Record<ListTab, [string, string]> = {
    gallery: ['Fotografias do espaço e do trabalho. Por agora, links https para imagens já publicadas (por exemplo no vosso site ou Instagram); o envio de fotos chega em breve.', 'Photos of the space and the work. For now, https links to images already online; photo uploads are coming soon.'],
    testimonials: ['Frases de clientes reais, com autorização. Curtas funcionam melhor.', 'Quotes from real clients, with their permission. Short ones work best.'],
    faq: ['Respostas às perguntas que mais vos fazem (estacionamento, o que trazer, gravidez, cartões de oferta...).', 'Answers to what people ask most (parking, what to bring, pregnancy, gift cards...).'],
  };
  const big = (f: string) => f.startsWith('quote') || f.startsWith('a_');
  return html`<form method="post" action="/admin/site?s=${tab}" class="form">${csrfField(ctx)}
    <p class="muted">${tr(l, hint[tab][0], hint[tab][1])} ${tr(l, `Até ${LIMITS[tab]}. Para remover, apague os campos.`, `Up to ${LIMITS[tab]}. To remove one, clear its fields.`)}</p>
    ${Array.from({ length: count }, (_, i) => html`<fieldset><legend>${i + 1}</legend>
      ${LIST_FIELDS[tab].map(([f, pt, en, max]) => html`<label>${tr(l, pt, en)}${big(f)
        ? html`<textarea name="${f}_${i}" rows="2" maxlength="${max}">${items[i]?.[f] ?? ''}</textarea>`
        : html`<input name="${f}_${i}" value="${items[i]?.[f] ?? ''}" maxlength="${max}" ${f === 'url' ? html`type="url"` : ''}>`}</label>`)}
    </fieldset>`)}
    <button class="btn" type="submit">${tr(l, 'Guardar no rascunho', 'Save to draft')}</button>
  </form>`;
}

function readRows(body: Record<string, unknown>, tab: ListTab): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  for (let i = 0; i < LIMITS[tab]; i++) {
    const row = Object.fromEntries(LIST_FIELDS[tab].map(([f]) => [f, typeof body[`${f}_${i}`] === 'string' ? (body[`${f}_${i}`] as string) : '']));
    if (Object.values(row).some((v) => v.trim())) rows.push(row);
  }
  return rows; // normalizeSite trims, validates links and drops incomplete rows
}
