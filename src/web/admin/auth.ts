import { sql } from '../../db.ts';
import { html } from '../../lib/html.ts';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../../lib/crypto.ts';
import { HttpError, checkSameOrigin, htmlReply, readBody, redirect, type Ctx, type Handler, type Reply } from '../../http/core.ts';
import { checkCsrf, createSession, destroySession, rateLimit } from '../../http/guards.ts';
import { adminPage, csrfField, flashFrom, tr } from './layout.ts';

/** Wraps an admin handler: requires a session and checks CSRF on POST. */
export function requireAdmin(h: Handler): Handler {
  return async (ctx) => {
    if (!ctx.session) return redirect(`/admin/login?next=${encodeURIComponent(ctx.path)}`);
    ctx.locale = ctx.session.locale;
    if (ctx.method === 'POST') {
      checkSameOrigin(ctx);
      checkCsrf(ctx, await readBody(ctx));
    }
    return h(ctx);
  };
}

export function requireOwner(h: Handler): Handler {
  return requireAdmin(async (ctx) => {
    if (ctx.session!.role !== 'owner') throw new HttpError(403, tr(ctx.locale, 'Só o responsável pode alterar isto.', 'Only the owner can change this.'));
    return h(ctx);
  });
}

function loginForm(ctx: Ctx, error = '', email = ''): Reply {
  const l = ctx.locale;
  const next = ctx.query.get('next') ?? '/admin';
  return htmlReply(adminPage(ctx, {
    title: tr(l, 'Entrar', 'Sign in'),
    body: html`<section class="login">
      <h1>${ctx.tenant!.name}</h1>
      <form method="post" action="/admin/login?next=${encodeURIComponent(next)}" class="form">
        ${error ? html`<p class="flash flash-error" role="alert">${error}</p>` : ''}
        <label>Email<input type="email" name="email" autocomplete="username" required value="${email}"></label>
        <label>${tr(l, 'Palavra-passe', 'Password')}<input type="password" name="password" autocomplete="current-password" required></label>
        <button class="btn" type="submit">${tr(l, 'Entrar', 'Sign in')}</button>
      </form>
    </section>`,
  }), error ? 401 : 200);
}

export function loginPage(ctx: Ctx): Reply {
  if (ctx.session) return redirect('/admin');
  return loginForm(ctx);
}

export async function loginSubmit(ctx: Ctx): Promise<Reply> {
  checkSameOrigin(ctx);
  const l = ctx.locale;
  const body = await readBody(ctx);
  const email = String(body.email ?? '').trim().toLowerCase().slice(0, 254);
  const password = String(body.password ?? '').slice(0, 200);
  const okIp = await rateLimit(`login-ip:${ctx.ip}`, 20, 900);
  const okAcct = await rateLimit(`login:${ctx.tenant!.id}:${email}`, 8, 900);
  if (!okIp || !okAcct) return loginForm(ctx, tr(l, 'Demasiadas tentativas. Tente daqui a 15 minutos.', 'Too many attempts. Try again in 15 minutes.'), email);

  const [user] = await sql<{ id: string; password_hash: string }[]>`
    select id, password_hash from users where tenant_id = ${ctx.tenant!.id} and lower(email) = ${email}`;
  const valid = user ? await verifyPassword(password, user.password_hash) : (await burnPasswordCheck(password), false);
  if (!user || !valid) return loginForm(ctx, tr(l, 'Email ou palavra-passe errados.', 'Wrong email or password.'), email);

  await sql`update users set last_login_at = now() where id = ${user.id}`;
  const setCookie = await createSession(ctx, user.id, ctx.tenant!.id);
  const next = ctx.query.get('next');
  return redirect(next && next.startsWith('/admin') ? next : '/admin', 303, { 'set-cookie': setCookie });
}

export async function logout(ctx: Ctx): Promise<Reply> {
  const setCookie = await destroySession(ctx);
  return redirect('/admin/login', 303, { 'set-cookie': setCookie });
}

export function accountPage(ctx: Ctx, error = ''): Reply {
  const l = ctx.locale;
  const s = ctx.session!;
  return htmlReply(adminPage(ctx, {
    title: tr(l, 'Conta', 'Account'),
    flash: error ? { kind: 'error', text: error } : flashFrom(ctx),
    body: html`<h1>${tr(l, 'Conta', 'Account')}</h1>
    <p>${s.name}, ${s.email}</p>
    <form method="post" action="/admin/account/language" class="form form-inline">${csrfField(ctx)}
      <label>${tr(l, 'Idioma do painel', 'Dashboard language')}
        <select name="locale"><option value="pt" ${l === 'pt' ? 'selected' : ''}>Português</option><option value="en" ${l === 'en' ? 'selected' : ''}>English</option></select></label>
      <button class="btn btn-quiet" type="submit">${tr(l, 'Guardar', 'Save')}</button>
    </form>
    <h2>${tr(l, 'Alterar palavra-passe', 'Change password')}</h2>
    <form method="post" action="/admin/account/password" class="form">${csrfField(ctx)}
      <label>${tr(l, 'Palavra-passe atual', 'Current password')}<input type="password" name="current" autocomplete="current-password" required></label>
      <label>${tr(l, 'Nova palavra-passe (mín. 10 caracteres)', 'New password (at least 10 characters)')}<input type="password" name="next" autocomplete="new-password" minlength="10" required></label>
      <button class="btn" type="submit">${tr(l, 'Alterar palavra-passe', 'Change password')}</button>
    </form>`,
  }), error ? 422 : 200);
}

export async function changePassword(ctx: Ctx): Promise<Reply> {
  const l = ctx.locale;
  const body = await readBody(ctx);
  const current = String(body.current ?? '');
  const next = String(body.next ?? '');
  const [u] = await sql<{ password_hash: string }[]>`select password_hash from users where id = ${ctx.session!.userId}`;
  if (!(await verifyPassword(current, u.password_hash))) return accountPage(ctx, tr(l, 'A palavra-passe atual está errada.', 'The current password is wrong.'));
  if (next.length < 10 || next.length > 200) return accountPage(ctx, tr(l, 'A nova palavra-passe precisa de pelo menos 10 caracteres.', 'The new password needs at least 10 characters.'));
  await sql`update users set password_hash = ${await hashPassword(next)} where id = ${ctx.session!.userId}`;
  // Sign out every other device.
  await sql`delete from sessions where user_id = ${ctx.session!.userId} and csrf_token <> ${ctx.session!.csrf}`;
  return redirect('/admin/account?ok=password');
}

export async function changeLanguage(ctx: Ctx): Promise<Reply> {
  const body = await readBody(ctx);
  const locale = body.locale === 'en' ? 'en' : 'pt';
  await sql`update users set locale = ${locale} where id = ${ctx.session!.userId}`;
  return redirect('/admin/account?ok=saved');
}
