// ifthenpay REST client (Portuguese payment institution supervised by
// Banco de Portugal). Each studio signs its own ifthenpay contract, so money
// goes straight to the studio and the platform never holds customer funds.
//
// Endpoints follow https://ifthenpay.com/docs/en/ and the official JS SDK.
import { config } from '../../config.ts';
import { hmacSha256Hex, safeEqual } from '../../lib/crypto.ts';

export interface IfthenpayKeys {
  mbKey?: string; // Multibanco dynamic references
  mbwayKey?: string; // MB WAY
  ccardKey?: string; // Credit/debit card (Visa, Mastercard)
  antiPhishingKey?: string; // shared secret sent back on every callback
}

export class GatewayError extends Error {
  readonly code: string;
  readonly detail: unknown;
  constructor(message: string, code: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/** Cents to the "12.30" string format ifthenpay expects. */
export function centsToAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** "12.3", "12,30", "12.30" to cents; null if malformed. */
export function amountToCents(s: string | null | undefined): number | null {
  if (!s) return null;
  const v = s.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  return Math.round(Number(v) * 100);
}

/** E.164 to ifthenpay's MB WAY phone format ("912345678" or "34#612345678"). */
export function toMbwayPhone(e164: string): string {
  if (e164.startsWith('+351')) return e164.slice(4);
  throw new GatewayError('MB WAY requires a Portuguese mobile number', 'invalid_phone');
}

type Fetch = typeof fetch;

async function call(fetchImpl: Fetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.ifthenpay.timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal, headers: { accept: 'application/json', 'content-type': 'application/json', ...(init.headers ?? {}) } });
    const text = await res.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
    if (!res.ok) throw new GatewayError(`ifthenpay HTTP ${res.status}`, 'http_error', body);
    if (typeof body !== 'object' || body === null) throw new GatewayError('Unexpected ifthenpay response', 'bad_response', body);
    return body as Record<string, unknown>;
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    throw new GatewayError('ifthenpay request failed', (err as Error).name === 'AbortError' ? 'timeout' : 'network', String(err));
  } finally {
    clearTimeout(timer);
  }
}

const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));

export interface MbwayInitResult { requestId: string; status: string; message: string }
export interface MbwayStatusResult { status: 'paid' | 'pending' | 'failed' | 'expired'; code: string; message: string }
export interface MultibancoResult { entity: string; reference: string; requestId: string; expiryDate: string | null }
export interface CardResult { paymentUrl: string; requestId: string }

export function createIfthenpayClient(keys: IfthenpayKeys, fetchImpl: Fetch = fetch) {
  const base = config.ifthenpay.baseUrl;

  return {
    /** Sends a payment request to the customer's MB WAY app (4 minutes to accept). */
    async mbwayRequest(p: { orderId: string; amountCents: number; phoneE164: string; email?: string | null; description: string; notificationUrl?: string }): Promise<MbwayInitResult> {
      if (!keys.mbwayKey) throw new GatewayError('MB WAY is not configured', 'not_configured');
      const body: Record<string, string> = {
        mbWayKey: keys.mbwayKey,
        orderId: p.orderId,
        amount: centsToAmount(p.amountCents),
        mobileNumber: toMbwayPhone(p.phoneE164),
        email: p.email ?? '',
        description: p.description.slice(0, 100),
      };
      if (p.notificationUrl) body.notificationUrl = p.notificationUrl;
      const r = await call(fetchImpl, `${base}/spg/payment/mbway`, { method: 'POST', body: JSON.stringify(body) });
      const status = s(r.Status);
      if (status !== '000') throw new GatewayError(s(r.Message) || 'MB WAY request refused', `mbway_${status || 'error'}`, r);
      return { requestId: s(r.RequestId), status, message: s(r.Message) };
    },

    async mbwayStatus(requestId: string): Promise<MbwayStatusResult> {
      if (!keys.mbwayKey) throw new GatewayError('MB WAY is not configured', 'not_configured');
      const url = `${base}/spg/payment/mbway/status?mbWayKey=${encodeURIComponent(keys.mbwayKey)}&requestId=${encodeURIComponent(requestId)}`;
      const r = await call(fetchImpl, url, { method: 'GET' });
      return mapMbwayStatus(s(r.Status), s(r.Message));
    },

    /** Generates a Multibanco entity + reference payable at any ATM or home banking. */
    async multibancoReference(p: { orderId: string; amountCents: number; description: string; expiryDays: number; email?: string | null }): Promise<MultibancoResult> {
      if (!keys.mbKey) throw new GatewayError('Multibanco is not configured', 'not_configured');
      const endpoint = config.ifthenpay.multibancoSandbox ? '/multibanco/reference/sandbox' : '/multibanco/reference/init';
      const r = await call(fetchImpl, `${base}${endpoint}`, {
        method: 'POST',
        body: JSON.stringify({
          mbKey: keys.mbKey,
          orderId: p.orderId,
          amount: centsToAmount(p.amountCents),
          description: p.description.slice(0, 200),
          // 0 = expires at the end of today; allowed: 0-32, 45, 60, 90, 120
          expiryDays: p.expiryDays,
        }),
      });
      if (s(r.Status) !== '0') throw new GatewayError(s(r.Message) || 'Multibanco reference refused', 'multibanco_error', r);
      return { entity: s(r.Entity), reference: s(r.Reference), requestId: s(r.RequestId), expiryDate: r.ExpiryDate ? s(r.ExpiryDate) : null };
    },

    /** Hosted card payment page; confirmation arrives by callback. */
    async cardPayment(p: { orderId: string; amountCents: number; successUrl: string; errorUrl: string; cancelUrl: string; language: 'pt' | 'en' }): Promise<CardResult> {
      if (!keys.ccardKey) throw new GatewayError('Card payments are not configured', 'not_configured');
      const r = await call(fetchImpl, `${base}/creditcard/init/${encodeURIComponent(keys.ccardKey)}`, {
        method: 'POST',
        body: JSON.stringify({
          orderId: p.orderId,
          amount: centsToAmount(p.amountCents),
          successUrl: p.successUrl,
          errorUrl: p.errorUrl,
          cancelUrl: p.cancelUrl,
          language: p.language,
        }),
      });
      if (s(r.Status) !== '0') throw new GatewayError(s(r.Message) || 'Card payment refused', 'card_error', r);
      return { paymentUrl: s(r.PaymentUrl), requestId: s(r.RequestId) };
    },
  };
}

export type IfthenpayClient = ReturnType<typeof createIfthenpayClient>;

export function mapMbwayStatus(code: string, message: string): MbwayStatusResult {
  switch (code) {
    case '000': return { status: 'paid', code, message };
    case '020': case '122': return { status: 'failed', code, message };
    case '101': return { status: 'expired', code, message };
    default: return { status: 'pending', code, message };
  }
}

/** Checks the anti-phishing key ifthenpay appends to every callback. */
export function verifyCallbackKey(expected: string | undefined, received: string | null): boolean {
  if (!expected || !received) return false;
  return safeEqual(expected, received);
}

/**
 * Verifies the X-Ifthenpay-Signature on MB WAY status notifications:
 * HMAC-SHA256(orderId + amount + requestId) keyed with the MB WAY key.
 */
export function verifyMbwayNotificationSignature(mbwayKey: string, orderId: string, amount: string, requestId: string, signature: string | null): boolean {
  if (!signature) return false;
  const expected = hmacSha256Hex(mbwayKey, `${orderId}${amount}${requestId}`);
  return safeEqual(expected, signature.toLowerCase());
}
