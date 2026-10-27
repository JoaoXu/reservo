import postgres from 'postgres';
import { config } from './config.ts';

// One connection pool per process. postgres.js uses tagged templates, so
// every interpolated value is sent as a bound parameter (no SQL injection).
export const sql = postgres(config.databaseUrl, {
  max: config.dbPoolMax,
  idle_timeout: 30,
  connect_timeout: 10,
  prepare: true,
  onnotice: () => {},
  transform: { undefined: null },
  connection: { application_name: 'reservo' },
  // Unix socket directory (e.g. Cloud SQL's /cloudsql/<instance>) overrides the URL host.
  ...(process.env.PGHOST?.startsWith('/') ? { host: process.env.PGHOST } : {}),
});

export type Sql = typeof sql;
// Either the pool or a transaction handle.
export type Tx = postgres.TransactionSql | Sql;

export function isExclusionViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23P01';
}

/** Concurrent inserts checked by the same exclusion constraint can deadlock; Postgres aborts one of them. */
export function isDeadlock(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '40P01';
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
