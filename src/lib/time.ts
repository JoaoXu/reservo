// Time-zone helpers built on Intl only (no dependencies). Portugal changes
// clocks twice a year, so every local time is converted to UTC through the
// zone rules instead of a fixed offset.

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = offsetFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    offsetFormatters.set(tz, f);
  }
  return f;
}

export interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }

export function toLocalParts(date: Date, tz: string): LocalParts {
  const p: Record<string, number> = {};
  for (const part of partsFormatter(tz).formatToParts(date)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second, weekday };
}

/** Offset of `tz` from UTC at instant `ms`, in milliseconds. */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = toLocalParts(new Date(ms), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Converts a wall-clock time in `tz` to a UTC Date. */
export function zonedToUtc(dateStr: string, minutesOfDay: number, tz: string): Date {
  const [y, m, d] = parseDateStr(dateStr);
  const naive = Date.UTC(y, m - 1, d, 0, minutesOfDay);
  const off1 = tzOffsetMs(naive - 0, tz);
  let t = naive - off1;
  const off2 = tzOffsetMs(t, tz);
  if (off2 !== off1) t = naive - off2;
  return new Date(t);
}

export function parseDateStr(s: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Invalid date ${s}`);
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new Error(`Invalid date ${s}`);
  }
  return [y, mo, d];
}

export function isDateStr(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try { parseDateStr(s); return true; } catch { return false; }
}

/** Local calendar date (YYYY-MM-DD) of an instant in `tz`. */
export function localDateStr(date: Date, tz: string): string {
  const p = toLocalParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function weekdayOf(dateStr: string): number {
  const [y, m, d] = parseDateStr(dateStr);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = parseDateStr(dateStr);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function minutesToHHMM(min: number): string {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

export function hhmmToMinutes(s: string): number | null {
  const m = /^([01]?\d|2[0-4]):([0-5]\d)$/.exec(s.trim());
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v <= 1440 ? v : null;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(locale: string, tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${tz}|${JSON.stringify(opts)}`;
  let f = fmtCache.get(key);
  if (!f) { f = new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts }); fmtCache.set(key, f); }
  return f;
}

const intlLocale = (l: string) => (l === 'en' ? 'en-GB' : 'pt-PT');

export function formatTime(d: Date, tz: string, locale = 'pt'): string {
  return fmt(intlLocale(locale), tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

export function formatDateLong(d: Date, tz: string, locale = 'pt'): string {
  return fmt(intlLocale(locale), tz, { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}

export function formatDateShort(d: Date, tz: string, locale = 'pt'): string {
  return fmt(intlLocale(locale), tz, { weekday: 'short', day: 'numeric', month: 'short' }).format(d);
}

export function formatDateStrLong(dateStr: string, locale = 'pt'): string {
  const [y, m, d] = parseDateStr(dateStr);
  return fmt(intlLocale(locale), 'UTC', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

export function formatMoney(cents: number, locale = 'pt'): string {
  const v = cents / 100;
  return new Intl.NumberFormat(intlLocale(locale), {
    style: 'currency', currency: 'EUR',
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2,
  }).format(v);
}
