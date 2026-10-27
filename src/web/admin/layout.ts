import { html, type SafeHtml } from '../../lib/html.ts';
import { tb, type Locale } from '../../lib/i18n.ts';
import type { Ctx } from '../../http/core.ts';
import { ASSET_VERSION, themeStyle } from '../layout.ts';

/** Inline bilingual text for the owner dashboard. */
export function tr(l: Locale, pt: string, en: string): string {
  return l === 'en' ? en : pt;
}

export function csrfField(ctx: Ctx): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${ctx.session?.csrf ?? ''}">`;
}

const NAV: { href: string; pt: string; en: string; icon: string }[] = [
  { href: '/admin', pt: 'Agenda', en: 'Agenda', icon: 'M4 5h16v15H4zM4 9h16M9 3v4M15 3v4' },
  { href: '/admin/bookings', pt: 'Marcações', en: 'Bookings', icon: 'M5 4h14v16H5zM8 9h8M8 13h8M8 17h5' },
  { href: '/admin/bookings/new', pt: 'Nova', en: 'New', icon: 'M12 5v14M5 12h14' },
  { href: '/admin/services', pt: 'Tratamentos', en: 'Treatments', icon: 'M6 4h12v16H6zM9 8h6M9 12h6' },
  { href: '/admin/team', pt: 'Equipa', en: 'Team', icon: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3 3-5 6-5s6 2 6 5M16 5a3 3 0 0 1 0 6M18 15c2 .5 3 2.5 3 5' },
  { href: '/admin/site', pt: 'Site', en: 'Website', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18' },
  { href: '/admin/settings', pt: 'Definições', en: 'Settings', icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4' },
];

function isActive(ctx: Ctx, href: string): boolean {
  if (href === '/admin') return ctx.path === '/admin';
  if (href === '/admin/bookings') return ctx.path === '/admin/bookings' || /^\/admin\/bookings\/[0-9a-f-]{36}/.test(ctx.path);
  return ctx.path === href || ctx.path.startsWith(href + '/');
}

export interface AdminPageOpts {
  title: string;
  body: SafeHtml;
  flash?: { kind: 'ok' | 'error'; text: string } | null;
  scripts?: string[];
}

export function adminPage(ctx: Ctx, opts: AdminPageOpts): SafeHtml {
  const tenant = ctx.tenant!;
  const l = ctx.locale;
  const s = ctx.session;
  return html`<!doctype html>
<html lang="${l === 'en' ? 'en' : 'pt-PT'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${opts.title} | ${tenant.name}</title>
<link rel="stylesheet" href="/static/css/admin.css?v=${ASSET_VERSION}">
<link rel="icon" href="/static/img/favicon.svg" type="image/svg+xml">
${themeStyle(tenant, ctx.nonce)}
</head>
<body class="admin">
${s ? html`<nav class="adm-nav" aria-label="${tr(l, 'Painel', 'Dashboard')}">
  <a class="adm-brand" href="/admin">${tenant.name}</a>
  <ul>
    ${NAV.map((n) => html`<li><a href="${n.href}" ${isActive(ctx, n.href) ? html`aria-current="page"` : ''}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${n.icon}"/></svg><span>${n.href === '/admin/services' ? tb(l, tenant.business_type, 'nav.services') : tr(l, n.pt, n.en)}</span></a></li>`)}
  </ul>
  <div class="adm-user">
    <a href="/" target="_blank" rel="noopener">${tr(l, 'Ver site', 'View site')}</a>
    <a href="/admin/account">${s.name}</a>
    <form method="post" action="/admin/logout">${csrfField(ctx)}<button type="submit" class="linklike">${tr(l, 'Sair', 'Sign out')}</button></form>
  </div>
</nav>` : ''}
<main class="adm-main" id="main">
  ${tenant.status === 'demo' ? html`<p class="adm-demo">${tr(l, 'Modo demonstração: os pagamentos são simulados e não são enviadas mensagens reais.', 'Demo mode: payments are simulated and no real messages are sent.')}</p>` : ''}
  ${opts.flash ? html`<p class="flash flash-${opts.flash.kind}" role="status">${opts.flash.text}</p>` : ''}
  ${opts.body}
</main>
<script src="/static/js/admin.js?v=${ASSET_VERSION}" defer></script>
${(opts.scripts ?? []).map((src) => html`<script src="${src}?v=${ASSET_VERSION}" defer></script>`)}
</body>
</html>`;
}

/** Flash messages travel in the redirect URL as a short code. */
const FLASH: Record<string, [string, string, 'ok' | 'error']> = {
  saved: ['Guardado.', 'Saved.', 'ok'],
  created: ['Marcação criada.', 'Booking created.', 'ok'],
  cancelled: ['Marcação cancelada. O cliente foi avisado.', 'Booking cancelled. The customer has been told.', 'ok'],
  updated: ['Marcação atualizada.', 'Booking updated.', 'ok'],
  paid: ['Pagamento registado.', 'Payment recorded.', 'ok'],
  deleted: ['Removido.', 'Removed.', 'ok'],
  password: ['Palavra-passe alterada.', 'Password changed.', 'ok'],
  anonymized: ['Dados do cliente apagados.', 'Customer data erased.', 'ok'],
  sent: ['Mensagem enviada.', 'Message sent.', 'ok'],
  draft: ['Guardado no rascunho. Pré-visualize e publique quando estiver pronto.', 'Saved to the draft. Preview it and publish when ready.', 'ok'],
  published: ['Publicado. O site já mostra as alterações.', 'Published. The site now shows your changes.', 'ok'],
  nodraft: ['Não há rascunho para publicar.', 'There is no draft to publish.', 'error'],
  discarded: ['Rascunho descartado.', 'Draft discarded.', 'ok'],
  restored: ['Versão reposta e publicada.', 'Version restored and published.', 'ok'],
};

/** The business type's word for a staff member ("Terapeuta", "Barbeiro"...). */
export function staffWord(ctx: Ctx): string {
  return tb(ctx.locale, ctx.tenant!.business_type, 'book.step_staff');
}

export function flashFrom(ctx: Ctx): AdminPageOpts['flash'] {
  const code = ctx.query.get('ok');
  const f = code ? FLASH[code] : undefined;
  return f ? { kind: f[2], text: tr(ctx.locale, f[0], f[1]) } : null;
}

export function fieldError(errors: Record<string, string>, field: string, l: Locale): SafeHtml | '' {
  const e = errors[field];
  if (!e) return '';
  const text = e === 'required' ? tr(l, 'Preencha este campo.', 'Fill in this field.') : tr(l, 'Verifique este valor.', 'Check this value.');
  return html`<span class="field-error" role="alert">${text}</span>`;
}
