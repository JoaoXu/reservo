// AWS Signature Version 4 for the few S3 calls we make (put/delete object),
// so the app doesn't need the AWS SDK. Verified against the example in the
// S3 documentation (see the unit tests).
import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }

export interface SignInput {
  method: string;
  url: URL;
  region: string;
  service: string;
  /** Extra headers to sign (lowercase names). host and x-amz-* are added. */
  headers?: Record<string, string>;
  body?: Buffer | string;
  /** Precomputed payload hash (e.g. from a fixed test vector); otherwise hashed from body. */
  payloadHash?: string;
  credentials: AwsCredentials;
  now?: Date;
}

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding, as SigV4 requires (encodeURIComponent leaves !'()* alone). */
function encode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Returns every header the request must send, Authorization included. */
export function signRequest(input: SignInput): Record<string, string> {
  const now = input.now ?? new Date();
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const payloadHash = input.payloadHash ?? sha256(input.body ?? '');
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    host: input.url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': date,
    ...(input.credentials.sessionToken ? { 'x-amz-security-token': input.credentials.sessionToken } : {}),
  };

  // S3 paths are encoded once, segment by segment.
  const canonicalUri = input.url.pathname.split('/').map((seg) => encode(decodeURIComponent(seg))).join('/') || '/';
  const canonicalQuery = [...input.url.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [input.method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, day), input.region), input.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`,
  };
}
