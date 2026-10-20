// Background jobs. Each job takes a Postgres advisory lock, so any number of
// app replicas (or a scheduler hitting /internal/cron) can run them safely:
// only one instance works at a time, the others skip.
import { sql } from '../db.ts';
import { config } from '../config.ts';
import { log } from '../lib/log.ts';
import { releaseExpiredHolds } from './bookings.ts';
import { notifyReminder } from './notify.ts';
import { refreshMbway } from './events.ts';
import { tenantById } from './tenants.ts';
import type { PaymentRow } from './payments/index.ts';

const LOCK_BASE = 77200000;

async function withLock(id: number, fn: () => Promise<unknown>): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [{ ok }] = await tx<{ ok: boolean }[]>`select pg_try_advisory_xact_lock(${LOCK_BASE + id}) as ok`;
    if (!ok) return false;
    await fn();
    return true;
  });
}

export async function jobReleaseHolds(): Promise<number> {
  const ids = await releaseExpiredHolds();
  if (ids.length) log.info('released expired holds', { count: ids.length });
  return ids.length;
}

/** 24 h reminders. Each booking is claimed with an UPDATE so it's sent once. */
export async function jobReminders(): Promise<number> {
  const due = await sql<{ id: string; tenant_id: string }[]>`
    update bookings set reminder_sent_at = now()
    where id in (
      select id from bookings
      where status = 'confirmed' and reminder_sent_at is null
        and starts_at between now() + interval '2 hours' and now() + interval '26 hours'
        and created_at < now() - interval '1 hour'
      order by starts_at limit 200
      for update skip locked)
    returning id, tenant_id`;
  for (const b of due) {
    try { await notifyReminder(b.tenant_id, b.id); } catch (err) { log.warn('reminder failed', { booking: b.id, err }); }
  }
  return due.length;
}

/** Catches MB WAY payments whose callback never arrived. */
export async function jobReconcileMbway(): Promise<number> {
  const pending = await sql<PaymentRow[]>`
    select * from payments
    where status = 'pending' and method = 'mbway'
      and created_at between now() - interval '20 minutes' and now() - interval '20 seconds'
      and (last_checked_at is null or last_checked_at < now() - interval '30 seconds')
    order by created_at limit 100`;
  let settled = 0;
  for (const p of pending) {
    try {
      const t = await tenantById(p.tenant_id);
      if (!t) continue;
      const s = await refreshMbway(t, p);
      if (s !== 'pending') settled++;
    } catch (err) {
      log.warn('mbway reconcile failed', { payment: p.id, err });
    }
  }
  return settled;
}

/** GDPR housekeeping: anonymise long-inactive customers, drop old sessions. */
export async function jobHousekeeping(): Promise<void> {
  await sql`delete from sessions where expires_at < now()`;
  await sql`delete from rate_limits where window_start < now() - interval '1 day'`;
  const anon = await sql`
    update customers c set name = 'Cliente removido', phone = 'anon-' || c.id, email = null, notes = '',
      marketing_consent = false, anonymized_at = now()
    where c.anonymized_at is null
      and c.created_at < now() - make_interval(months => ${config.retentionMonths})
      and not exists (
        select 1 from bookings b where b.customer_id = c.id
        and b.starts_at > now() - make_interval(months => ${config.retentionMonths}))
    returning c.id`;
  if (anon.length) log.info('anonymised inactive customers', { count: anon.length });
}

let lastHousekeeping = 0;

/** One pass of every job. Called every minute by the worker or by /internal/cron. */
export async function runJobs(): Promise<Record<string, number | boolean>> {
  const out: Record<string, number | boolean> = {};
  out.holds = await withLock(1, async () => { out.released = await jobReleaseHolds(); });
  out.reconcile = await withLock(2, async () => { out.settled = await jobReconcileMbway(); });
  out.reminders = await withLock(3, async () => { out.reminded = await jobReminders(); });
  if (Date.now() - lastHousekeeping > 3_600_000) {
    lastHousekeeping = Date.now();
    out.housekeeping = await withLock(4, jobHousekeeping);
  }
  return out;
}

export function startJobLoop(intervalMs = 60_000): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try { await runJobs(); } catch (err) { log.error('job pass failed', { err }); }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, 2_000);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
