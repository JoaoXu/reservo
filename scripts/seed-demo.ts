// Creates (or recreates) the demo businesses from their client files: every
// clients/*.json with "status": "demo" (Maré, the massage studio, and
// Navalha, the barbershop). They are fictional: payments are simulated and
// no messages are sent. Extra domains (e.g. "localhost") go to Maré.
//   npm run seed:demo -- [extra-domain...] [--with-bookings]
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, closeDb } from '../src/db.ts';
import { isMain } from '../src/lib/main.ts';
import { config } from '../src/config.ts';
import { applyClient, parseClientSpec } from '../src/domain/provision.ts';

export const DEMO = {
  slug: 'mare',
  email: 'demo@reservo.pt',
  password: process.env.DEMO_PASSWORD || 'mare-demo-2026',
};

const CLIENTS_DIR = join(import.meta.dirname, '..', 'clients');
export const DEMO_FILE = join(CLIENTS_DIR, 'mare.json');

/** Wipes a demo business (bookings included) and sets it up again from its file. */
export async function seedDemoFile(file: string, extraDomains: string[] = [], ownerPassword?: string): Promise<{ id: string; slug: string; name: string; email: string; password: string | null }> {
  const spec = parseClientSpec(JSON.parse(await readFile(file, 'utf8')));
  if (spec.status !== 'demo') throw new Error(`${file} is not a demo business`);
  await sql`delete from tenants where slug = ${spec.slug}`;
  const r = await applyClient(spec, { extraDomains, ownerPassword });
  return { id: r.tenantId, slug: spec.slug, name: spec.name, email: spec.owner.email, password: ownerPassword ?? spec.owner.password };
}

/** Maré, the demo the tests and the docs use. */
export async function seedDemo(extraDomains: string[] = []): Promise<string> {
  return (await seedDemoFile(DEMO_FILE, extraDomains, DEMO.password)).id;
}

export async function demoFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const f of (await readdir(CLIENTS_DIR)).filter((n) => n.endsWith('.json')).sort()) {
    const raw = JSON.parse(await readFile(join(CLIENTS_DIR, f), 'utf8')) as { status?: string };
    if (raw.status === 'demo') files.push(join(CLIENTS_DIR, f));
  }
  return files;
}

/** A few realistic bookings for tomorrow and the day after, so the agenda isn't empty in a demo. */
export async function seedDemoBookings(tenantId: string): Promise<number> {
  const { tenantById } = await import('../src/domain/tenants.ts');
  const { createBooking, getSlots } = await import('../src/domain/bookings.ts');
  const { addDays, localDateStr } = await import('../src/lib/time.ts');
  const tenant = (await tenantById(tenantId))!;
  const services = await sql<{ id: string; name_pt: string }[]>`select id, name_pt from services where tenant_id = ${tenantId} order by sort`;
  const people = [
    ['Sofia Martins', '+351912000101', 'pt'], ['Emma Clarke', '+447700900456', 'en'], ['João Pereira', '+351913000202', 'pt'],
    ['Lukas Becker', '+491512345678', 'en'], ['Beatriz Costa', '+351914000303', 'pt'], ['Marta Ribeiro', '+351915000404', 'pt'],
    ['Chloé Dubois', '+33612345678', 'en'], ['Tiago Almeida', '+351916000505', 'pt'],
  ] as const;
  let made = 0;
  const today = localDateStr(new Date(), tenant.timezone);
  for (let d = 1; d <= 2; d++) {
    const date = addDays(today, d);
    for (let i = 0; i < 4; i++) {
      const p = people[(d - 1) * 4 + i];
      const svc = services[(i * 2 + d) % services.length];
      const r = await getSlots(tenant, svc.id, date, null, { ignoreRules: true });
      const slot = r?.slots[Math.min(r.slots.length - 1, Math.floor((r.slots.length / 4) * i) + 1)];
      if (!slot) continue;
      try {
        await createBooking(tenant, {
          serviceId: svc.id, staffId: null, start: slot.start,
          customer: { name: p[0], phone: p[1], email: null, locale: p[2], note: '', marketingConsent: false },
          source: i % 2 ? 'admin' : 'online', payment: 'studio', ignoreRules: true,
        });
        made++;
      } catch { /* slot taken, skip */ }
    }
  }
  return made;
}

if (isMain(import.meta.url)) {
  try {
    const extra = process.argv.slice(2).filter((a) => !a.startsWith('--'));
    const local = config.platformDomain === 'localhost';
    for (const file of await demoFiles()) {
      const isMare = file === DEMO_FILE;
      const d = await seedDemoFile(file, isMare ? extra : [], isMare ? DEMO.password : undefined);
      console.log(`${d.name}: ${local ? 'http' : 'https'}://${d.slug}.${config.platformDomain}${local ? `:${config.port}` : ''}/  dashboard /admin  login ${d.email} / ${d.password}`);
      if (process.argv.includes('--with-bookings')) console.log(`  sample bookings: ${await seedDemoBookings(d.id)}`);
    }
  } finally {
    await closeDb();
  }
}
