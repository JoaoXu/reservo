// Tiny auto-escaping HTML templating. `html` escapes every interpolated
// value unless it is already a SafeHtml (from another `html` call or `raw`).
// This is the main defence against XSS in server-rendered pages.

export class SafeHtml {
  readonly value: string;
  constructor(value: string) { this.value = value; }
  toString(): string { return this.value; }
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"'`]/g, (c) => ESC[c]);
}

type Value = SafeHtml | string | number | boolean | null | undefined | Value[];

function render(v: Value): string {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return escapeHtml(String(v));
}

export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Trusted markup only (never user input). */
export function raw(s: string): SafeHtml {
  return new SafeHtml(s);
}

/** Plain text with line breaks, for owner-written paragraphs. */
export function paragraphs(text: string | undefined | null): SafeHtml {
  if (!text) return raw('');
  return raw(text.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join(''));
}

/** Safe JSON for embedding in <script type="application/json">. */
export function jsonForScript(data: unknown): SafeHtml {
  return raw(JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'));
}

/** Only http(s) URLs may reach href/src attributes. */
export function safeUrl(u: string | null | undefined): string {
  if (!u) return '';
  try {
    const url = new URL(u, 'https://placeholder.invalid');
    if (url.protocol === 'http:' || url.protocol === 'https:') return u;
  } catch { /* fall through */ }
  return '';
}
