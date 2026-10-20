// Customer and owner messages. Channels: WhatsApp (Meta Cloud API, with
// pre-approved templates), SMS and email (Brevo). In development every
// channel just logs. A failure on one channel never breaks a booking.
import { sql } from '../db.ts';
import { config } from '../config.ts';
import { log } from '../lib/log.ts';
import { t, type Locale, type MsgKey } from '../lib/i18n.ts';
import { formatDateLong, formatMoney, formatTime } from '../lib/time.ts';
import { escapeHtml } from '../lib/html.ts';
import { bookingView, manageTokenFor, manageUrl, type BookingView } from './bookings.ts';
import { tenantBaseUrl, tenantById, type Tenant } from './tenants.ts';
import type { PaymentRow } from './payments/index.ts';

type Channel = 'email' | 'sms' | 'whatsapp';

interface Outgoing {
  tenant: Tenant;
  bookingId: string | null;
  template: string;
  channel: Channel;
  to: string;
  subject: string;
  text: string;
  // WhatsApp template parameters (body variables in order)
  waTemplate?: string;
  waParams?: string[];
}

async function deliver(m: Outgoing): Promise<void> {
  let status = 'sent', error: string | null = null;
  try {
    if (m.channel === 'email') await sendEmail(m);
    else if (m.channel === 'sms') await sendSms(m);
    else await sendWhatsapp(m);
  } catch (err) {
    status = 'failed';
    error = String((err as Error).message).slice(0, 300);
    log.warn('notification failed', { tenant: m.tenant.slug, channel: m.channel, template: m.template, err });
  }
  await sql`insert into notifications (tenant_id, booking_id, channel, template, recipient, status, error)
            values (${m.tenant.id}, ${m.bookingId}, ${m.channel}, ${m.template}, ${maskRecipient(m.to)}, ${status}, ${error})`;
}

function maskRecipient(to: string): string {
  if (to.includes('@')) return to.replace(/^(.).*(@.*)$/, '$1***$2');
  return to.replace(/^(\+\d{3})\d+(\d{3})$/, '$1•••$2');
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function sendEmail(m: Outgoing): Promise<void> {
  if (config.notify.emailProvider === 'log') { log.info('email (not sent)', { to: maskRecipient(m.to), subject: m.subject, text: m.text }); return; }
  const htmlBody = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1e2b2a">${escapeHtml(m.text).replace(/\n/g, '<br>')}</div>`;
  await postJson('https://api.brevo.com/v3/smtp/email', { 'api-key': config.notify.brevoApiKey }, {
    sender: { name: m.tenant.name, email: config.notify.emailFrom },
    replyTo: m.tenant.content.email ? { email: m.tenant.content.email, name: m.tenant.name } : undefined,
    to: [{ email: m.to }],
    subject: m.subject,
    textContent: m.text,
    htmlContent: htmlBody,
  });
}

async function sendSms(m: Outgoing): Promise<void> {
  if (config.notify.smsProvider === 'log') { log.info('sms (not sent)', { to: maskRecipient(m.to), text: m.text }); return; }
  await postJson('https://api.brevo.com/v3/transactionalSMS/sms', { 'api-key': config.notify.brevoApiKey }, {
    sender: config.notify.smsSender.slice(0, 11),
    recipient: m.to.replace(/^\+/, ''),
    content: m.text.slice(0, 600),
    type: 'transactional',
  });
}

async function sendWhatsapp(m: Outgoing): Promise<void> {
  if (config.notify.whatsappProvider === 'log' || !m.waTemplate) { log.info('whatsapp (not sent)', { to: maskRecipient(m.to), text: m.text }); return; }
  await postJson(`https://graph.facebook.com/v21.0/${config.notify.metaWhatsappPhoneId}/messages`, { authorization: `Bearer ${config.notify.metaWhatsappToken}` }, {
    messaging_product: 'whatsapp',
    to: m.to.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: m.waTemplate,
      language: { code: config.notify.waTemplateLang },
      components: [{ type: 'body', parameters: (m.waParams ?? []).map((text) => ({ type: 'text', text })) }],
    },
  });
}

/** Phone channel: WhatsApp when configured, otherwise SMS. */
function phoneChannel(): Channel {
  return config.notify.whatsappProvider !== 'log' ? 'whatsapp' : 'sms';
}

interface Vars extends Record<string, string> { name: string; service: string; staff: string; when: string; time: string; ref: string; studio: string; address: string; link: string; site: string }

function varsFor(tenant: Tenant, b: BookingView, link: string): Vars {
  const l = b.locale;
  return {
    name: b.customer_name.split(' ')[0],
    service: l === 'en' && b.service_name_en ? b.service_name_en : b.service_name_pt,
    staff: b.staff_name,
    when: `${formatDateLong(b.starts_at, tenant.timezone, l)}, ${formatTime(b.starts_at, tenant.timezone, l)}`,
    time: formatTime(b.starts_at, tenant.timezone, l),
    ref: b.ref,
    studio: tenant.name,
    address: [tenant.content.address, tenant.content.city].filter(Boolean).join(', '),
    link,
    site: tenantBaseUrl(tenant),
  };
}

async function toCustomer(tenant: Tenant, b: BookingView, template: string, subjectKey: MsgKey, bodyKey: MsgKey, vars: Record<string, string>, wa?: { template: string; params: string[] }): Promise<void> {
  const l: Locale = b.locale;
  const subject = t(l, subjectKey, vars);
  const text = t(l, bodyKey, vars);
  const jobs: Promise<void>[] = [];
  const ch = phoneChannel();
  jobs.push(deliver({ tenant, bookingId: b.id, template, channel: ch, to: b.customer_phone, subject, text, waTemplate: wa?.template, waParams: wa?.params }));
  if (b.customer_email) jobs.push(deliver({ tenant, bookingId: b.id, template, channel: 'email', to: b.customer_email, subject, text }));
  await Promise.all(jobs);
}

async function toOwner(tenant: Tenant, b: BookingView, template: string, subjectKey: MsgKey, bodyKey: MsgKey, vars: Record<string, string>): Promise<void> {
  if (!tenant.notify_owner_email) return;
  const l = tenant.default_locale;
  await deliver({ tenant, bookingId: b.id, template, channel: 'email', to: tenant.notify_owner_email, subject: t(l, subjectKey, vars), text: t(l, bodyKey, vars) });
}

async function load(tenantId: string, bookingId: string): Promise<{ tenant: Tenant; b: BookingView } | null> {
  const tenant = await tenantById(tenantId);
  const b = tenant && (await bookingView(tenantId, { id: bookingId }));
  return tenant && b ? { tenant, b } : null;
}

function linkFor(tenant: Tenant, b: BookingView): string {
  return manageUrl(tenant, b.ref, manageTokenFor(b.id));
}

export async function notifyConfirmed(tenantId: string, bookingId: string): Promise<void> {
  const ctx = await load(tenantId, bookingId);
  if (!ctx) return;
  const { tenant, b } = ctx;
  const link = linkFor(tenant, b);
  const v = varsFor(tenant, b, link);
  await toCustomer(tenant, b, 'confirmed', 'msg.confirm_subject', 'msg.confirm_body', v,
    { template: config.notify.waTemplateConfirm, params: [v.name, v.service, v.when, v.ref, v.link] });
  await toOwner(tenant, b, 'owner_new', 'msg.owner_new_subject', 'msg.owner_new_body', {
    ...v, name: b.customer_name, phone: b.customer_phone, paid: formatMoney(b.paid_cents, tenant.default_locale),
    admin: `${tenantBaseUrl(tenant)}/admin/bookings/${b.id}`,
  });
}

export async function notifyMultibanco(tenantId: string, bookingId: string, p: PaymentRow): Promise<void> {
  const ctx = await load(tenantId, bookingId);
  if (!ctx || !p.mb_reference) return;
  const { tenant, b } = ctx;
  const link = linkFor(tenant, b);
  const v = varsFor(tenant, b, link);
  await toCustomer(tenant, b, 'multibanco', 'msg.multibanco_subject', 'msg.multibanco_body', {
    ...v,
    entity: p.mb_entity ?? '',
    reference: formatReference(p.mb_reference),
    amount: formatMoney(p.amount_cents, b.locale),
    until: p.expires_at ? `${formatDateLong(p.expires_at, tenant.timezone, b.locale)} ${formatTime(p.expires_at, tenant.timezone, b.locale)}` : '',
  });
}

export async function notifyReminder(tenantId: string, bookingId: string): Promise<void> {
  const ctx = await load(tenantId, bookingId);
  if (!ctx) return;
  const { tenant, b } = ctx;
  const link = linkFor(tenant, b);
  const v = varsFor(tenant, b, link);
  await toCustomer(tenant, b, 'reminder', 'msg.reminder_subject', 'msg.reminder_body', v,
    { template: config.notify.waTemplateReminder, params: [v.name, v.service, v.when, v.link] });
}

export async function notifyCancelled(tenantId: string, bookingId: string, by: 'customer' | 'owner'): Promise<void> {
  const ctx = await load(tenantId, bookingId);
  if (!ctx) return;
  const { tenant, b } = ctx;
  const v = varsFor(tenant, b, '');
  if (by === 'owner') await toCustomer(tenant, b, 'cancelled', 'msg.cancel_subject', 'msg.cancel_body', v);
  else await toOwner(tenant, b, 'owner_cancel', 'msg.owner_cancel_subject', 'msg.owner_cancel_body', {
    ...v, name: b.customer_name, admin: `${tenantBaseUrl(tenant)}/admin/bookings/${b.id}`,
  });
}

export async function notifyLatePayment(tenantId: string, bookingId: string, amountCents: number): Promise<void> {
  const ctx = await load(tenantId, bookingId);
  if (!ctx) return;
  const { tenant, b } = ctx;
  const v = varsFor(tenant, b, '');
  await toOwner(tenant, b, 'owner_late', 'msg.owner_late_subject', 'msg.owner_late_body', {
    ...v, name: b.customer_name, amount: formatMoney(amountCents, tenant.default_locale),
    admin: `${tenantBaseUrl(tenant)}/admin/bookings/${b.id}`,
  });
}

export function formatReference(r: string): string {
  return r.replace(/\D/g, '').replace(/(\d{3})(?=\d)/g, '$1 ');
}

