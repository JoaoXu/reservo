import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.ts';

const scrypt = promisify(scryptCb) as (pw: string | Buffer, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

// scrypt parameters: N=2^15 is ~50ms on a small vCPU and needs 32 MiB.
const N = 32768, R = 8, P = 1, KEYLEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// A hash computed for unknown emails so login timing doesn't reveal which exist.
let dummyHash: string | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummyHash);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function hmacSha256Hex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab); // keep timing similar
    return false;
  }
  return timingSafeEqual(ab, bb);
}

// Short human-friendly codes (no 0/O/1/I confusion), e.g. booking refs.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function shortCode(len: number): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// --- Encryption at rest for tenant payment keys (AES-256-GCM) -----------
function dataKey(): Buffer {
  const key = Buffer.from(config.dataKey, 'base64');
  if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return key;
}

export function encryptJson(value: unknown): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  // layout: version(1) | iv(12) | tag(16) | ciphertext
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
}

export function decryptJson<T>(blob: Buffer | Uint8Array | null | undefined): T | null {
  if (!blob) return null;
  const buf = Buffer.from(blob);
  if (buf[0] !== 1) throw new Error('Unknown secret format');
  const iv = buf.subarray(1, 13), tag = buf.subarray(13, 29), body = buf.subarray(29);
  const decipher = createDecipheriv('aes-256-gcm', dataKey(), iv);
  decipher.setAuthTag(tag);
  const text = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  return JSON.parse(text) as T;
}
