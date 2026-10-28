// A business's image library. Files are stored at t/<tenant_id>/<file>:
// locally under MEDIA_DIR (served by the app at /media), in production in S3
// behind CloudFront. Pages refer to images by file name only and build the URL
// with the business's own tenant id, so one business can't show another's.
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Tx } from '../db.ts';
import { config } from '../config.ts';
import { log } from '../lib/log.ts';
import { signRequest, type AwsCredentials } from '../lib/sigv4.ts';
import { IMAGE_EXT, checkImage, type ImageType } from '../lib/images.ts';

export const FILE_RE = /^[0-9a-f-]{16,36}\.(jpg|png|webp)$/;

export interface Media {
  id: string;
  tenant_id: string;
  file: string;
  content_type: ImageType;
  bytes: number;
  width: number;
  height: number;
  name: string;
  created_by: string;
  created_at: Date;
}

export class MediaError extends Error {
  readonly code: 'too_many' | 'in_use' | 'not_found';
  readonly where: string[];
  constructor(code: MediaError['code'], where: string[] = []) {
    super(code);
    this.code = code;
    this.where = where;
  }
}

export function mediaKey(tenantId: string, file: string): string {
  return `t/${tenantId}/${file}`;
}

/** URL browsers load the image from, always under this business's own prefix. */
export function mediaUrl(tenantId: string, file: string | null | undefined): string {
  return file && FILE_RE.test(file) ? `${config.media.baseUrl}/${mediaKey(tenantId, file)}` : '';
}

// --- Storage --------------------------------------------------------------------
interface Storage {
  put(key: string, data: Buffer, type: ImageType): Promise<void>;
  remove(key: string): Promise<void>;
}

const local: Storage = {
  async put(key, data) {
    const path = join(config.media.dir, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  },
  async remove(key) {
    await unlink(join(config.media.dir, key)).catch(() => {});
  },
};

/** Reads a locally stored file (development and tests only). */
export async function readLocal(key: string): Promise<Buffer | null> {
  return readFile(join(config.media.dir, key)).catch(() => null);
}

// Credentials: the ECS task role (container credentials endpoint), or
// AWS_ACCESS_KEY_ID/... in the environment (e.g. from `aws configure export-credentials`).
let cached: (AwsCredentials & { expires: number }) | null = null;

async function credentials(): Promise<AwsCredentials> {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, sessionToken: process.env.AWS_SESSION_TOKEN };
  }
  if (cached && cached.expires - Date.now() > 5 * 60_000) return cached;
  const rel = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  if (!rel) throw new Error('No AWS credentials for media storage');
  const r = await fetch(`http://169.254.170.2${rel}`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`Container credentials: HTTP ${r.status}`);
  const c = (await r.json()) as { AccessKeyId: string; SecretAccessKey: string; Token: string; Expiration: string };
  cached = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.Token, expires: Date.parse(c.Expiration) };
  return cached;
}

async function s3(method: 'PUT' | 'DELETE', key: string, data?: Buffer, type?: string): Promise<void> {
  const url = new URL(`https://${config.media.bucket}.s3.${config.media.region}.amazonaws.com/${key}`);
  const headers = signRequest({
    method, url, region: config.media.region, service: 's3', body: data ?? '', credentials: await credentials(),
    // Names are unique (uuid or content hash), so the files never change.
    headers: data ? { 'content-type': type!, 'cache-control': 'public, max-age=31536000, immutable' } : {},
  });
  delete headers.host; // fetch sets it
  const r = await fetch(url, { method, headers, body: data ? new Uint8Array(data) : undefined, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`S3 ${method} ${key}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}

const s3Storage: Storage = {
  put: (key, data, type) => s3('PUT', key, data, type),
  remove: (key) => s3('DELETE', key),
};

function storage(): Storage {
  return config.media.storage === 's3' ? s3Storage : local;
}

// --- Library --------------------------------------------------------------------
export async function listMedia(tenantId: string): Promise<Media[]> {
  return sql<Media[]>`select * from media where tenant_id = ${tenantId} order by created_at desc, file`;
}

/** Which of these file names belong to this business. */
export async function ownFiles(tenantId: string, files: string[]): Promise<Set<string>> {
  const wanted = files.filter((f) => FILE_RE.test(f));
  if (!wanted.length) return new Set();
  const rows = await sql<{ file: string }[]>`select file from media where tenant_id = ${tenantId} and file in ${sql(wanted)}`;
  return new Set(rows.map((r) => r.file));
}

/** The file name a content-hashed image gets (after cleaning), for plans and dedupe. */
export function hashedFileName(img: { data: Buffer; type: ImageType }): string {
  return `${createHash('sha256').update(img.data).digest('hex').slice(0, 32)}.${IMAGE_EXT[img.type]}`;
}

/**
 * Checks, cleans and stores an image. With contentHash the file name comes
 * from the bytes, so storing the same image twice returns the existing one
 * (client files rely on this); otherwise it's a fresh uuid.
 */
export async function addMedia(tenantId: string, input: Buffer, opts: { name?: string; by?: string; contentHash?: boolean; tx?: Tx } = {}): Promise<Media> {
  const tx = opts.tx ?? sql;
  const img = checkImage(input); // throws ImageError
  const file = opts.contentHash ? hashedFileName(img) : `${randomUUID()}.${IMAGE_EXT[img.type]}`;
  if (opts.contentHash) {
    const [existing] = await tx<Media[]>`select * from media where tenant_id = ${tenantId} and file = ${file}`;
    if (existing) return existing;
  }
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from media where tenant_id = ${tenantId}`;
  if (n >= config.media.maxPerTenant) throw new MediaError('too_many');
  await storage().put(mediaKey(tenantId, file), img.data, img.type);
  const [row] = await tx<Media[]>`
    insert into media (tenant_id, file, content_type, bytes, width, height, name, created_by)
    values (${tenantId}, ${file}, ${img.type}, ${img.data.length}, ${img.width}, ${img.height},
      ${(opts.name ?? '').replace(/[^\p{L}\p{N} ._()-]/gu, '').slice(0, 120)}, ${opts.by ?? ''})
    on conflict (tenant_id, file) do update set name = media.name
    returning *`;
  return row;
}

/** Where a file is used on the live site, in the draft, or as a team photo. */
export async function mediaInUse(tenantId: string, file: string): Promise<string[]> {
  const rows = await sql<{ status: string }[]>`
    select status from site_versions
    where tenant_id = ${tenantId} and status in ('published', 'draft')
      and (theme::text like ${'%' + file + '%'} or site::text like ${'%' + file + '%'})`;
  const staff = await sql<{ name: string }[]>`select name from staff where tenant_id = ${tenantId} and photo_file = ${file}`;
  return [...rows.map((r) => r.status), ...staff.map((s) => `staff:${s.name}`)];
}

/**
 * Deletes an image that nothing current uses. Older site versions that showed
 * it simply show the page without it if restored.
 */
export async function deleteMedia(tenantId: string, id: string): Promise<void> {
  const [m] = await sql<Media[]>`select * from media where tenant_id = ${tenantId} and id = ${id}`;
  if (!m) throw new MediaError('not_found');
  const where = await mediaInUse(tenantId, m.file);
  if (where.length) throw new MediaError('in_use', where);
  await sql`delete from media where id = ${m.id}`;
  try {
    await storage().remove(mediaKey(tenantId, m.file));
  } catch (err) {
    log.warn('media file not removed from storage', { tenant: tenantId, file: m.file, err });
  }
}
