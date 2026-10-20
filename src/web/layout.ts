import { html, raw, safeUrl, type SafeHtml } from '../lib/html.ts';
import { t, type Locale } from '../lib/i18n.ts';
import type { Ctx } from '../http/core.ts';
import type { Tenant } from '../domain/tenants.ts';

export const ASSET_VERSION = '1';

const DEFAULT_THEME = { ink: '#1d3a35', paper: '#eef2ee', accent: '#7a4e63', soft: '#dfe7e1' };

/** Theme colours as CSS custom properties; values are validated hex at save time. */
export function themeStyle(tenant: Tenant, nonce: string): SafeHtml {
  const th = { ...DEFAULT_THEME, ...tenant.theme };
  const hex = (v: string | undefined, d: string) => (v && /^#[0-9a-f]{6}$/i.test(v) ? v : d);
  return raw(`<style nonce="${nonce}">:root{--ink:${hex(th.ink, DEFAULT_THEME.ink)};--paper:${hex(th.paper, DEFAULT_THEME.paper)};--accent:${hex(th.accent, DEFAULT_THEME.accent)};--soft:${hex(th.soft, DEFAULT_THEME.soft)}}</style>`);
}

export function langHref(ctx: Ctx): string {
  const other = ctx.locale === 'pt' ? 'en' : 'pt';
  const q = new URLSearchParams(ctx.query);
  q.set('lang', other);
  return `${ctx.path}?${q.toString()}`;
}

export function whatsappLink(number: string | undefined, text = ''): string {
  if (!number) return '';
  const digits = number.replace(/\D/g, '');
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

interface PageOpts {
  title: string;
  description?: string;
  body: SafeHtml;
  bodyClass?: string;
  scripts?: string[];
  noindex?: boolean;
}

export function sitePage(ctx: Ctx, opts: PageOpts): SafeHtml {
  const tenant = ctx.tenant!;
  const l: Locale = ctx.locale;
  const logo = safeUrl(tenant.theme.logo_url);
  return html`<!doctype html>
<html lang="${l === 'en' ? 'en' : 'pt-PT'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${opts.title}</title>
${opts.description ? html`<meta name="description" content="${opts.description}">` : ''}
${opts.noindex ? html`<meta name="robots" content="noindex">` : ''}
<meta name="theme-color" content="${tenant.theme.paper ?? DEFAULT_THEME.paper}">
<link rel="preload" href="/static/fonts/newsreader.woff" as="font" type="font/woff" crossorigin>
<link rel="stylesheet" href="/static/css/site.css?v=${ASSET_VERSION}">
<link rel="icon" href="/static/img/favicon.svg" type="image/svg+xml">
${themeStyle(tenant, ctx.nonce)}
</head>
<body class="${opts.bodyClass ?? ''}">
<a class="skip" href="#main">${l === 'en' ? 'Skip to content' : 'Saltar para o conteúdo'}</a>
<header class="topbar">
  <a class="wordmark" href="/">${logo ? html`<img src="${logo}" alt="${tenant.name}">` : tenant.name}</a>
  <nav class="topnav" aria-label="${l === 'en' ? 'Main' : 'Principal'}">
    <a href="/#tratamentos">${t(l, 'nav.services')}</a>
    <a href="/#equipa">${t(l, 'nav.team')}</a>
    <a href="/#visite">${t(l, 'nav.visit')}</a>
    <a class="lang" href="${langHref(ctx)}" hreflang="${l === 'pt' ? 'en' : 'pt'}">${t(l, 'lang.switch')}</a>
  </nav>
  <a class="btn btn-small" href="/marcar">${t(l, 'nav.book')}</a>
</header>
<main id="main">
${opts.body}
</main>
${siteFooter(ctx)}
${(opts.scripts ?? []).map((s) => html`<script src="${s}?v=${ASSET_VERSION}" defer></script>`)}
</body>
</html>`;
}

function siteFooter(ctx: Ctx): SafeHtml {
  const tenant = ctx.tenant!;
  const c = tenant.content;
  const l = ctx.locale;
  const year = new Date().getFullYear();
  return html`<footer class="footer">
  <div class="footer-inner">
    <div>
      <p class="footer-name">${tenant.name}</p>
      ${c.address ? html`<p>${c.address}${c.postal_code ? html`<br>${c.postal_code} ${c.city ?? ''}` : ''}</p>` : ''}
    </div>
    <ul class="footer-links">
      <li><a href="/privacidade">${t(l, 'footer.privacy')}</a></li>
      <li><a href="/cancelamentos">${t(l, 'footer.policy')}</a></li>
      <li><a href="https://www.livroreclamacoes.pt/" rel="noopener" target="_blank">${t(l, 'footer.complaints')}</a></li>
    </ul>
  </div>
  <p class="footer-small">© ${year} ${c.legal_name || tenant.name}${c.nif ? html`, NIF ${c.nif}` : ''}. <a href="https://reservo.pt" rel="noopener">${t(l, 'footer.powered')}</a></p>
</footer>`;
}
