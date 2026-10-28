// The image library: upload (resized in the browser, checked again here),
// browse, delete. Owner only. Also the picker used by the website and team
// forms to choose an image from the library.
import { extname } from 'node:path';
import { html, type SafeHtml } from '../../lib/html.ts';
import { ImageError } from '../../lib/images.ts';
import { isUuid } from '../../lib/validate.ts';
import { config } from '../../config.ts';
import { HttpError, checkSameOrigin, htmlReply, jsonReply, readRaw, redirect, type Ctx, type Handler, type Reply } from '../../http/core.ts';
import { FILE_RE, MediaError, addMedia, deleteMedia, listMedia, mediaUrl, readLocal, type Media } from '../../domain/media.ts';
import { adminPage, csrfField, flashFrom, tr } from './layout.ts';

/**
 * Uploads send the image as the raw body, so the usual form-based CSRF check
 * can't read a token from it: the token travels in a header instead, on top of
 * the same-origin check.
 */
export function ownerUpload(h: Handler): Handler {
  return async (ctx) => {
    const l = ctx.locale;
    if (!ctx.session) throw new HttpError(401, tr(l, 'Inicie sessão outra vez.', 'Please sign in again.'));
    checkSameOrigin(ctx);
    if (ctx.req.headers['x-csrf-token'] !== ctx.session.csrf) throw new HttpError(403, 'Invalid form token');
    if (ctx.session.role !== 'owner') throw new HttpError(403, tr(l, 'Só o responsável pode alterar isto.', 'Only the owner can change this.'));
    return h(ctx);
  };
}

export async function mediaUpload(ctx: Ctx): Promise<Reply> {
  const l = ctx.locale;
  const data = await readRaw(ctx, config.media.maxBytes);
  const name = decodeURIComponent(String(ctx.req.headers['x-file-name'] ?? '')).slice(0, 200);
  try {
    const m = await addMedia(ctx.tenant!.id, data, { name: name.replace(extname(name), ''), by: ctx.session!.name });
    return jsonReply({ id: m.id, file: m.file, url: mediaUrl(m.tenant_id, m.file), width: m.width, height: m.height }, 201);
  } catch (err) {
    if (err instanceof ImageError) return jsonReply({ error: tr(l, 'Este ficheiro não é uma imagem JPEG, PNG ou WebP válida.', 'This file isn’t a valid JPEG, PNG or WebP image.') }, 415);
    if (err instanceof MediaError && err.code === 'too_many') {
      return jsonReply({ error: tr(l, `Chegou ao limite de ${config.media.maxPerTenant} fotos. Apague algumas antes de carregar mais.`, `You’ve reached the limit of ${config.media.maxPerTenant} photos. Delete some first.`) }, 409);
    }
    throw err;
  }
}

function kb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export async function mediaPage(ctx: Ctx, error = ''): Promise<Reply> {
  const l = ctx.locale;
  const items = await listMedia(ctx.tenant!.id);
  const body = html`<h1>${tr(l, 'Fotos', 'Photos')}</h1>
  <p class="muted">${tr(l, 'Logótipo, foto de capa, galeria e fotos da equipa. As fotos são reduzidas no telemóvel ou computador antes de enviar, e a localização GPS é removida.', 'Logo, cover photo, gallery and team photos. Photos are resized on your phone or computer before upload, and GPS location is removed.')}
    ${tr(l, `JPEG, PNG ou WebP, até ${config.media.maxPerTenant} fotos.`, `JPEG, PNG or WebP, up to ${config.media.maxPerTenant} photos.`)}</p>
  ${error ? html`<p class="flash flash-error" role="alert">${error}</p>` : ''}
  <div class="upload">
    <label class="btn" for="media-files">${tr(l, 'Carregar fotos', 'Upload photos')}</label>
    <input id="media-files" class="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple data-csrf="${ctx.session!.csrf}"
      data-msg-working="${tr(l, 'A enviar', 'Uploading')}" data-msg-done="${tr(l, 'Pronto', 'Done')}" data-msg-failed="${tr(l, 'Falhou', 'Failed')}"
      data-msg-unreadable="${tr(l, 'Não foi possível abrir esta imagem. Use JPEG ou PNG.', 'Couldn’t open this image. Use JPEG or PNG.')}">
    <noscript><p class="muted">${tr(l, 'Para carregar fotos é preciso JavaScript.', 'Uploading photos needs JavaScript.')}</p></noscript>
    <ul id="media-status" class="upload-status" aria-live="polite"></ul>
  </div>
  ${items.length ? html`<ul class="media-grid">${items.map((m) => html`<li class="media-card">
    <img src="${mediaUrl(m.tenant_id, m.file)}" alt="" loading="lazy">
    <div class="media-meta">
      <span class="media-name">${m.name || m.file}</span>
      <small class="muted">${m.width}×${m.height}, ${kb(m.bytes)}</small>
      <form method="post" action="/admin/media/${m.id}/delete">${csrfField(ctx)}<button class="linklike danger" type="submit">${tr(l, 'Apagar', 'Delete')}</button></form>
    </div>
  </li>`)}</ul>` : html`<p class="empty">${tr(l, 'Ainda não há fotos.', 'No photos yet.')}</p>`}`;
  return htmlReply(adminPage(ctx, { title: tr(l, 'Fotos', 'Photos'), body, flash: flashFrom(ctx), scripts: ['/static/js/admin-media.js'] }), error ? 409 : 200);
}

export async function mediaDelete(ctx: Ctx): Promise<Reply> {
  const l = ctx.locale;
  if (!isUuid(ctx.params.id)) throw new HttpError(404, 'Not found');
  try {
    await deleteMedia(ctx.tenant!.id, ctx.params.id);
  } catch (err) {
    if (!(err instanceof MediaError)) throw err;
    if (err.code === 'not_found') throw new HttpError(404, 'Not found');
    const where = err.where.map((w) => w === 'published' ? tr(l, 'no site publicado', 'on the live site')
      : w === 'draft' ? tr(l, 'no rascunho', 'in the draft') : tr(l, `na foto de ${w.slice(6)}`, `as ${w.slice(6)}’s photo`)).join(', ');
    return mediaPage(ctx, tr(l, `Esta foto está a ser usada (${where}). Troque-a lá primeiro.`, `This photo is in use (${where}). Replace it there first.`));
  }
  return redirect('/admin/media?ok=deleted');
}

/** Serves locally stored images (development and tests). In production CloudFront serves them. */
export async function localMedia(ctx: Ctx): Promise<Reply> {
  const { tenant, file } = ctx.params;
  if (config.media.storage !== 'local' || !isUuid(tenant) || !FILE_RE.test(file)) throw new HttpError(404, 'Not found');
  const data = await readLocal(`t/${tenant}/${file}`);
  if (!data) throw new HttpError(404, 'Not found');
  const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  return { status: 200, headers: { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable' }, body: data };
}

/** Radio grid to pick one library image (or none) for a form field. */
export function mediaPicker(ctx: Ctx, name: string, items: Media[], selected: string | null | undefined): SafeHtml {
  const l = ctx.locale;
  return html`<div class="picker">
    <label class="pick pick-none"><input type="radio" name="${name}" value="" ${selected ? '' : 'checked'}><span>${tr(l, 'Nenhuma', 'None')}</span></label>
    ${items.map((m) => html`<label class="pick"><input type="radio" name="${name}" value="${m.file}" ${selected === m.file ? 'checked' : ''}>
      <img src="${mediaUrl(m.tenant_id, m.file)}" alt="${m.name || m.file}" loading="lazy"></label>`)}
  </div>
  ${items.length ? '' : html`<p class="muted"><a href="/admin/media">${tr(l, 'Carregue fotos primeiro', 'Upload photos first')}</a></p>`}`;
}
