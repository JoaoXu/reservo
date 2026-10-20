// Creates (or recreates) the demo studio "Maré" in Lisbon, used to show the
// product to studio owners. Payments are simulated; no messages are sent.
//   npm run seed:demo
import { sql, closeDb } from '../src/db.ts';
import { hashPassword } from '../src/lib/crypto.ts';
import { isMain } from '../src/lib/main.ts';
import { config } from '../src/config.ts';

export const DEMO = {
  slug: 'mare',
  email: 'demo@reservo.pt',
  password: process.env.DEMO_PASSWORD || 'mare-demo-2026',
};

export async function seedDemo(extraDomains: string[] = []): Promise<string> {
  return sql.begin(async (tx) => {
    await tx`delete from tenants where slug = ${DEMO.slug}`;
    const [t] = await tx<{ id: string }[]>`
      insert into tenants (slug, name, status, timezone, default_locale, content, theme,
        slot_interval_min, min_lead_min, max_advance_days, cancel_window_hours,
        payment_mode, deposit_percent, pay_at_studio_allowed, mbway_hold_min, multibanco_hold_hours,
        payment_provider, notify_owner_email)
      values (${DEMO.slug}, 'Maré', 'demo', 'Europe/Lisbon', 'pt',
        ${tx.json({
          tagline_pt: 'Uma hora só para si, a dois passos do rio.',
          tagline_en: 'An hour that’s only yours, two streets from the river.',
          intro_pt: 'Massagem terapêutica e de relaxamento em Alfama. Três salas, três terapeutas, marcação em dois minutos.',
          intro_en: 'Therapeutic and relaxing massage in Alfama. Three rooms, three therapists, booked in two minutes.',
          about_pt: 'A Maré abriu em 2019 numa antiga casa de pescadores. Trabalhamos com óleos portugueses de produção pequena e deixamos sempre quinze minutos entre clientes, para que ninguém chegue com pressa nem saia a correr.\n\nSe é a primeira vez, diga-nos na marcação o que sente e o que prefere evitar. Ajustamos a pressão e o ritmo a si.',
          about_en: 'Maré opened in 2019 in an old fisherman’s house. We use small-batch Portuguese oils and always leave fifteen minutes between clients, so no one arrives in a hurry or leaves in a rush.\n\nIf it’s your first time, tell us when you book how you feel and what you’d rather avoid. We adjust pressure and pace to you.',
          address: 'Rua dos Remédios, Alfama', postal_code: '', city: 'Lisboa',
          map_url: 'https://maps.google.com/?q=Rua+dos+Rem%C3%A9dios+Lisboa',
          phone: '+351 210 000 000', whatsapp: '+351910000000', email: 'ola@mare.example', instagram: '@mare.lisboa',
          hours_note_pt: 'Feriados: consulte a disponibilidade online.', hours_note_en: 'Public holidays: check online availability.',
          legal_name: 'Maré Bem-Estar, Lda. (demonstração)', nif: '',
        } as never)},
        ${tx.json({ ink: '#1d3a35', paper: '#eef2ee', accent: '#7a4e63', soft: '#dfe7e1' } as never)},
        15, 120, 60, 24, 'deposit', 30, true, 10, 24, 'mock', ${'owner@mare.example'})
      returning id`;

    const domains = [`${DEMO.slug}.${config.platformDomain}`, ...extraDomains];
    for (const [i, d] of domains.entries()) {
      await tx`insert into tenant_domains (domain, tenant_id, is_primary) values (${d}, ${t.id}, ${i === 0})
               on conflict (domain) do update set tenant_id = excluded.tenant_id, is_primary = excluded.is_primary`;
    }

    await tx`insert into users (tenant_id, email, name, password_hash, role) values (${t.id}, ${DEMO.email}, 'Teresa Lobo', ${await hashPassword(DEMO.password)}, 'owner')`;

    const services = [
      ['Massagens', 'Massagem de relaxamento', 'Relaxing massage', 'Movimentos lentos e envolventes, com óleo morno. Para desligar a cabeça.', 'Slow, enveloping strokes with warm oil. For switching your head off.', 60, 15, 5500],
      ['Massagens', 'Massagem de relaxamento longa', 'Long relaxing massage', 'A mesma, com tempo para pés, mãos e couro cabeludo.', 'The same, with time for feet, hands and scalp.', 90, 15, 7500],
      ['Massagens', 'Tecidos profundos', 'Deep tissue', 'Pressão firme em costas, pescoço e ombros. Boa para quem passa o dia ao computador.', 'Firm pressure on back, neck and shoulders. Good if you spend the day at a desk.', 60, 15, 6500],
      ['Massagens', 'Pedras quentes', 'Hot stones', 'Basalto aquecido que solta os músculos antes das mãos.', 'Heated basalt that loosens muscles before the hands do.', 75, 20, 7800],
      ['Terapias', 'Drenagem linfática manual', 'Manual lymphatic drainage', 'Método Vodder, suave e ritmado. Indicada para pernas pesadas e pós-voo.', 'Vodder method, gentle and rhythmic. For heavy legs and after long flights.', 60, 15, 6000],
      ['Terapias', 'Reflexologia podal', 'Foot reflexology', 'Pressão em pontos dos pés, sentado e vestido.', 'Pressure on points of the feet, seated and fully clothed.', 45, 10, 4000],
      ['Terapias', 'Massagem pré-natal', 'Pregnancy massage', 'De lado, com almofadas, a partir das 14 semanas.', 'Side-lying with cushions, from 14 weeks.', 60, 15, 6000],
    ] as const;
    const serviceIds: string[] = [];
    for (const [i, s] of services.entries()) {
      const [row] = await tx<{ id: string }[]>`
        insert into services (tenant_id, category, name_pt, name_en, description_pt, description_en, duration_min, buffer_min, price_cents, sort)
        values (${t.id}, ${s[0]}, ${s[1]}, ${s[2]}, ${s[3]}, ${s[4]}, ${s[5]}, ${s[6]}, ${s[7]}, ${i}) returning id`;
      serviceIds.push(row.id);
    }

    const staff = [
      { name: 'Inês Carvalho', title_pt: 'Massagem desportiva e tecidos profundos', title_en: 'Sports and deep tissue massage', bio_pt: 'Fisioterapeuta de formação, doze anos de experiência com atletas.', bio_en: 'Trained physiotherapist, twelve years working with athletes.', skip: [6] },
      { name: 'Rafael Monteiro', title_pt: 'Relaxamento e pedras quentes', title_en: 'Relaxation and hot stones', bio_pt: 'Aprendeu em Chiang Mai e trouxe o ritmo lento para Alfama.', bio_en: 'Trained in Chiang Mai and brought the slow pace to Alfama.', skip: [4, 6] },
      { name: 'Mariana Sousa', title_pt: 'Drenagem linfática e pré-natal', title_en: 'Lymphatic drainage and pregnancy', bio_pt: 'Especializada no método Vodder e em acompanhamento na gravidez.', bio_en: 'Specialises in the Vodder method and care during pregnancy.', skip: [2, 3] },
    ];
    // weekday -> shifts [start, end] in minutes
    const hours: Record<string, Record<number, [number, number][]>> = {
      'Inês Carvalho': { 1: [[600, 780], [840, 1140]], 2: [[600, 780], [840, 1140]], 3: [[600, 780], [840, 1140]], 4: [[720, 1200]], 5: [[600, 1080]] },
      'Rafael Monteiro': { 2: [[720, 1200]], 3: [[720, 1200]], 4: [[600, 1080]], 5: [[720, 1200]], 6: [[600, 1080]] },
      'Mariana Sousa': { 1: [[600, 1080]], 3: [[600, 1080]], 4: [[600, 1080]], 5: [[600, 1080]], 6: [[600, 960]] },
    };
    for (const [i, s] of staff.entries()) {
      const [row] = await tx<{ id: string }[]>`
        insert into staff (tenant_id, name, title_pt, title_en, bio_pt, bio_en, sort)
        values (${t.id}, ${s.name}, ${s.title_pt}, ${s.title_en}, ${s.bio_pt}, ${s.bio_en}, ${i}) returning id`;
      for (const [si, sid] of serviceIds.entries()) {
        if (!s.skip.includes(si)) await tx`insert into staff_services (tenant_id, staff_id, service_id) values (${t.id}, ${row.id}, ${sid})`;
      }
      for (const [wd, shifts] of Object.entries(hours[s.name])) {
        for (const [a, b] of shifts) {
          await tx`insert into working_hours (tenant_id, staff_id, weekday, start_min, end_min) values (${t.id}, ${row.id}, ${Number(wd)}, ${a}, ${b})`;
        }
      }
    }
    return t.id;
  });
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
