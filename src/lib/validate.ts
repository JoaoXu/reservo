// Small input validators. Each returns a cleaned value or records an error,
// so a form can report every problem at once.

export class FieldErrors {
  readonly errors: Record<string, string> = {};
  add(field: string, code: string): void { this.errors[field] ??= code; }
  get ok(): boolean { return Object.keys(this.errors).length === 0; }
}

type Input = Record<string, unknown>;

export function str(input: Input, field: string, errs: FieldErrors, opts: { min?: number; max?: number; required?: boolean } = {}): string {
  const { min = 0, max = 500, required = true } = opts;
  const raw = input[field];
  const v = typeof raw === 'string' ? raw.trim().replace(/\u0000/g, '') : '';
  if (!v) {
    if (required) errs.add(field, 'required');
    return '';
  }
  if (v.length < min) errs.add(field, 'too_short');
  if (v.length > max) errs.add(field, 'too_long');
  return v.slice(0, max);
}

export function int(input: Input, field: string, errs: FieldErrors, opts: { min?: number; max?: number; required?: boolean } = {}): number {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, required = true } = opts;
  const raw = input[field];
  if (raw === undefined || raw === null || raw === '') {
    if (required) errs.add(field, 'required');
    return 0;
  }
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < min || n > max) { errs.add(field, 'invalid'); return 0; }
  return n;
}

/** Euros typed by a person ("55", "55,50", "55.5") to integer cents. */
export function euros(input: Input, field: string, errs: FieldErrors): number {
  const raw = String(input[field] ?? '').trim().replace(/\s|€/g, '').replace(',', '.');
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(raw)) { errs.add(field, 'invalid'); return 0; }
  return Math.round(Number(raw) * 100);
}

export function bool(input: Input, field: string): boolean {
  const v = input[field];
  return v === true || v === 'on' || v === 'true' || v === '1' || v === 'yes';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function uuid(input: Input, field: string, errs: FieldErrors, required = true): string | null {
  const v = input[field];
  if (v === undefined || v === null || v === '') {
    if (required) errs.add(field, 'required');
    return null;
  }
  if (!isUuid(v)) { errs.add(field, 'invalid'); return null; }
  return v.toLowerCase();
}

export function email(input: Input, field: string, errs: FieldErrors, required = false): string | null {
  const v = str(input, field, errs, { max: 254, required });
  if (!v) return null;
  if (!/^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i.test(v)) { errs.add(field, 'invalid'); return null; }
  return v.toLowerCase();
}

/**
 * Normalises a phone number to E.164. Portuguese numbers may be typed
 * without the country code (9 digits starting with 2, 3 or 9).
 */
export function normalizePhone(rawInput: string): string | null {
  let s = rawInput.replace(/[\s().-]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^[239]\d{8}$/.test(s)) s = '+351' + s;
  if (!/^\+[1-9]\d{7,14}$/.test(s)) return null;
  if (s.startsWith('+351') && !/^\+351[239]\d{8}$/.test(s)) return null;
  return s;
}

export function phone(input: Input, field: string, errs: FieldErrors, required = true): string {
  const v = str(input, field, errs, { max: 30, required });
  if (!v) return '';
  const p = normalizePhone(v);
  if (!p) { errs.add(field, 'invalid'); return ''; }
  return p;
}

export function isPortugueseMobile(e164: string): boolean {
  return /^\+3519\d{8}$/.test(e164);
}

export function oneOf<T extends string>(input: Input, field: string, allowed: readonly T[], errs: FieldErrors, fallback?: T): T {
  const v = input[field];
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  if (fallback !== undefined && (v === undefined || v === '')) return fallback;
  errs.add(field, 'invalid');
  return (fallback ?? allowed[0]);
}

export function hexColor(input: Input, field: string, errs: FieldErrors, fallback: string): string {
  const v = String(input[field] ?? '').trim();
  if (!v) return fallback;
  if (!/^#[0-9a-f]{6}$/i.test(v)) { errs.add(field, 'invalid'); return fallback; }
  return v.toLowerCase();
}

export function httpUrl(input: Input, field: string, errs: FieldErrors): string | null {
  const v = str(input, field, errs, { max: 500, required: false });
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
    return u.toString();
  } catch {
    errs.add(field, 'invalid');
    return null;
  }
}
