// Applies migrations/*.sql in order, once each. Safe to run from several
// deploy jobs at the same time: an advisory lock serialises them.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, closeDb } from '../src/db.ts';
import { isMain } from '../src/lib/main.ts';

const dir = join(import.meta.dirname, '..', 'migrations');

export async function migrate(): Promise<string[]> {
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(77100001)`;
    await tx`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
    const done = new Set((await tx<{ version: string }[]>`select version from schema_migrations`).map((r) => r.version));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const body = await readFile(join(dir, file), 'utf8');
      await tx.unsafe(body);
      await tx`insert into schema_migrations (version) values (${file})`;
      applied.push(file);
    }
  });
  return applied;
}

if (isMain(import.meta.url)) {
  try {
    const applied = await migrate();
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
