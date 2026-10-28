// Sets up or updates a business from its client file. Safe to re-run:
// only differences are applied. Shows the changes, like a plan.
//   npm run tenant:apply -- clients/casa-lotus.json [--dry-run] [--overwrite-site] [--domain host]...
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { closeDb } from '../src/db.ts';
import { isMain } from '../src/lib/main.ts';
import { config } from '../src/config.ts';
import { SpecError, applyClient, parseClientSpec } from '../src/domain/provision.ts';

if (isMain(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'dry-run': { type: 'boolean' }, 'overwrite-site': { type: 'boolean' }, domain: { type: 'string', multiple: true } },
  });
  const file = positionals[0];
  if (!file) {
    console.error('Usage: npm run tenant:apply -- clients/<slug>.json [--dry-run] [--overwrite-site] [--domain host]...');
    process.exit(1);
  }
  try {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      throw new Error(`Can't read ${file}: ${(err as Error).message}`);
    }
    const spec = parseClientSpec(raw);
    const dryRun = !!values['dry-run'];
    const r = await applyClient(spec, { dryRun, overwriteSite: !!values['overwrite-site'], extraDomains: values.domain ?? [], baseDir: dirname(file) });
    console.log(`${dryRun ? 'Plan for' : 'Applied'} ${spec.name} (${spec.slug}):`);
    console.log(r.changes.length ? r.changes.map((c) => `  + ${c}`).join('\n') : '  no changes');
    for (const w of r.warnings) console.log(`  ! ${w}`);
    if (dryRun) {
      console.log('Dry run: nothing was saved.');
    } else {
      const local = config.platformDomain === 'localhost';
      console.log(`Site: ${local ? 'http' : 'https'}://${spec.slug}.${config.platformDomain}${local ? `:${config.port}` : ''}/  (dashboard: /admin)`);
      if (r.ownerPassword) console.log(`Owner login: ${spec.owner.email}\nTemporary password (shown once): ${r.ownerPassword}`);
    }
  } catch (err) {
    console.error(err instanceof SpecError ? err.message : `Error: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
