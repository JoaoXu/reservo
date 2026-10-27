// Creates (or recreates) the demo business "Maré" from clients/mare.json,
// used to show the product to owners. Maré is fictional: payments are
// simulated and no messages are sent.
//   npm run seed:demo -- [extra-domain...] [--with-bookings]
import { readFile } from 'node:fs/promises';
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

export const DEMO_FILE = join(import.meta.dirname, '..', 'clients', 'mare.json');

/** Wipes Maré (bookings included) and sets it up again from its client file. */
export async function seedDemo(extraDomains: string[] = []): Promise<string> {
  const spec = parseClientSpec(JSON.parse(await readFile(DEMO_FILE, 'utf8')));
  await sql`delete from tenants where slug = ${DEMO.slug}`;
  const r = await applyClient(spec, { extraDomains, ownerPassword: DEMO.password });
  return r.tenantId;
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
    const id = await seedDemo(extra);
    if (process.argv.includes('--with-bookings')) console.log(`Sample bookings: ${await seedDemoBookings(id)}`);
    console.log(`Demo studio ready at http://${DEMO.slug}.${config.platformDomain}:${config.port}`);
    console.log(`Dashboard: /admin  login ${DEMO.email} / ${DEMO.password}`);
  } finally {
    await closeDb();
  }
}
