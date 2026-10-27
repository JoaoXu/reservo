// Onboards a new studio from the command line. For a full setup (texts,
// services, team, hours) prefer a client file: npm run tenant:apply.
//   npm run tenant:create -- --slug casa-lotus --name "Casa Lótus" \
//     --owner-email ana@casalotus.pt --owner-name "Ana Lima" [--domain casalotus.pt] [--trial-days 30]
// Prints a one-time password for the owner; they should change it on first login.
import { parseArgs } from 'node:util';
import { sql, closeDb } from '../src/db.ts';
import { hashPassword, randomToken } from '../src/lib/crypto.ts';
import { isMain } from '../src/lib/main.ts';
import { config } from '../src/config.ts';
import { defaultSite, publishFields } from '../src/domain/sites.ts';

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      slug: { type: 'string' }, name: { type: 'string' },
      'owner-email': { type: 'string' }, 'owner-name': { type: 'string' },
      domain: { type: 'string', multiple: true }, 'trial-days': { type: 'string' },
    },
  });
  const slug = values.slug ?? '', name = values.name ?? '', email = (values['owner-email'] ?? '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug) || !name || !email.includes('@')) {
    console.error('Usage: --slug <a-z0-9-> --name <studio name> --owner-email <email> [--owner-name <name>] [--domain <domain>]... [--trial-days N]');
    process.exit(1);
  }
  const password = randomToken(12);
  const trialDays = Number(values['trial-days'] ?? '30');
  try {
    await sql.begin(async (tx) => {
      const [t] = await tx<{ id: string }[]>`
        insert into tenants (slug, name, status, trial_ends_at, notify_owner_email, content)
        values (${slug}, ${name}, 'trial', now() + make_interval(days => ${trialDays}), ${email}, ${tx.json({ email } as never)}) returning id`;
      const domains = [`${slug}.${config.platformDomain}`, ...(values.domain ?? []).map((d) => d.toLowerCase())];
      for (const [i, d] of domains.entries()) {
        await tx`insert into tenant_domains (domain, tenant_id, is_primary) values (${d}, ${t.id}, ${i === domains.length - 1})`;
      }
      await tx`insert into users (tenant_id, email, name, password_hash, role) values (${t.id}, ${email}, ${values['owner-name'] ?? name}, ${await hashPassword(password)}, 'owner')`;
      await publishFields(tx, t.id, { name, content: { email }, theme: {}, site: defaultSite() }, 'tenant:create', 'Initial version');
    });
    console.log(`Created ${name}: https://${slug}.${config.platformDomain}/admin`);
    console.log(`Owner login: ${email}`);
    console.log(`Temporary password (shown once): ${password}`);
  } finally {
    await closeDb();
  }
}
