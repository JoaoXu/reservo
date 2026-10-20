import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zonedToUtc, localDateStr, addDays, weekdayOf, formatMoney } from '../src/lib/time.ts';
import { computeSlots } from '../src/domain/availability.ts';
import { html, raw, safeUrl } from '../src/lib/html.ts';
import { normalizePhone, FieldErrors, euros } from '../src/lib/validate.ts';
import { amountToCents, centsToAmount, toMbwayPhone, verifyMbwayNotificationSignature, mapMbwayStatus, verifyCallbackKey } from '../src/domain/payments/ifthenpay.ts';
import { encryptJson, decryptJson, hashPassword, verifyPassword } from '../src/lib/crypto.ts';
import { multibancoExpiryDays } from '../src/domain/payments/index.ts';

const TZ = 'Europe/Lisbon';

test('Lisbon wall clock converts to UTC across daylight saving', () => {
  // Summer (UTC+1)
  assert.equal(zonedToUtc('2026-07-01', 10 * 60, TZ).toISOString(), '2026-07-01T09:00:00.000Z');
  // Winter (UTC+0)
  assert.equal(zonedToUtc('2026-12-01', 10 * 60, TZ).toISOString(), '2026-12-01T10:00:00.000Z');
  // Day clocks go back (25 Oct 2026): 10:00 is already winter time
  assert.equal(zonedToUtc('2026-10-25', 10 * 60, TZ).toISOString(), '2026-10-25T10:00:00.000Z');
  assert.equal(localDateStr(new Date('2026-10-20T23:30:00Z'), TZ), '2026-10-21');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(weekdayOf('2026-10-20'), 2); // Tuesday
});

test('slots respect hours, bookings, buffer, lead time and the spring-forward gap', () => {
  const now = new Date('2026-07-01T06:00:00Z'); // 07:00 Lisbon
  const busy = [{ start: zonedToUtc('2026-07-01', 12 * 60, TZ).getTime(), end: zonedToUtc('2026-07-01', 13 * 60 + 15, TZ).getTime() }];
  const slots = computeSlots(
    { date: '2026-07-01', tz: TZ, durationMin: 60, bufferMin: 15, slotIntervalMin: 30, now, minLeadMin: 120, maxAdvanceDays: 60 },
    [{ staffId: 'a', hours: [{ start_min: 9 * 60, end_min: 15 * 60 }], busy }],
  );
  const times = slots.map((s) => s.start.toISOString().slice(11, 16));
  // 09:00 Lisbon (08:00Z) is the first time after the 2 h lead (from 07:00)
  // 10:30 + 60 + 15 = 11:45 OK; 11:00 + 75 overlaps 12:00 booking; booking blocks until 13:15
  assert.deepEqual(times, ['08:00', '08:30', '09:00', '09:30', '12:30', '13:00']);

  // 29 Mar 2026: clocks jump 01:00 -> 02:00, so 01:xx does not exist
  const gap = computeSlots(
    { date: '2026-03-29', tz: TZ, durationMin: 30, bufferMin: 0, slotIntervalMin: 30, now: new Date('2026-03-01T00:00:00Z'), minLeadMin: 0, maxAdvanceDays: 60 },
    [{ staffId: 'a', hours: [{ start_min: 0, end_min: 180 }], busy: [] }],
  );
  const starts = gap.map((s) => s.start.getTime());
  assert.equal(new Set(starts).size, starts.length, 'no duplicate instants');
});

test('slots merge therapists and keep who is free at each time', () => {
  const now = new Date('2026-07-01T00:00:00Z');
  const slots = computeSlots(
    { date: '2026-07-02', tz: TZ, durationMin: 60, bufferMin: 0, slotIntervalMin: 60, now, minLeadMin: 0, maxAdvanceDays: 60 },
    [
      { staffId: 'a', hours: [{ start_min: 600, end_min: 720 }], busy: [] },
      { staffId: 'b', hours: [{ start_min: 660, end_min: 780 }], busy: [] },
    ],
  );
  assert.deepEqual(slots.map((s) => s.staffIds), [['a'], ['a', 'b'], ['b']]);
});

test('html escapes interpolated values but keeps nested templates', () => {
  const name = '<img src=x onerror=alert(1)>';
  assert.equal(html`<p>${name}</p>`.value, '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  assert.equal(html`<div>${html`<b>${'a&b'}</b>`}</div>`.value, '<div><b>a&amp;b</b></div>');
  assert.equal(html`${raw('<br>')}`.value, '<br>');
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('https://example.com/a'), 'https://example.com/a');
});

test('phone numbers normalise to E.164', () => {
  assert.equal(normalizePhone('912 345 678'), '+351912345678');
  assert.equal(normalizePhone('00351 912345678'), '+351912345678');
  assert.equal(normalizePhone('+44 7700 900123'), '+447700900123');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('+351 812345678'), null);
});

test('euro amounts typed by people', () => {
  const e = new FieldErrors();
  assert.equal(euros({ v: '55' }, 'v', e), 5500);
  assert.equal(euros({ v: '55,5' }, 'v', e), 5550);
  assert.equal(euros({ v: '€ 12.30' }, 'v', e), 1230);
  assert.ok(e.ok);
  euros({ v: '12.345' }, 'v', e);
  assert.ok(!e.ok);
  assert.match(formatMoney(5550, 'pt'), /55,50/);
});

test('ifthenpay helpers', () => {
  assert.equal(centsToAmount(1950), '19.50');
  assert.equal(amountToCents('19.5'), 1950);
  assert.equal(amountToCents('19,50'), 1950);
  assert.equal(amountToCents('abc'), null);
  assert.equal(toMbwayPhone('+351912345678'), '912345678');
  assert.throws(() => toMbwayPhone('+447700900123'));
  assert.equal(mapMbwayStatus('000', '').status, 'paid');
  assert.equal(mapMbwayStatus('020', '').status, 'failed');
  assert.equal(mapMbwayStatus('101', '').status, 'expired');
  assert.equal(mapMbwayStatus('123', '').status, 'pending');
  assert.ok(verifyCallbackKey('abc', 'abc'));
  assert.ok(!verifyCallbackKey('abc', 'abd'));
  assert.ok(!verifyCallbackKey(undefined, 'abc'));
});

test('MB WAY notification signature matches the example in the ifthenpay docs', () => {
  // https://ifthenpay.com/docs/en/guides/callback/ : orderId + amount + requestId, HMAC-SHA256 with the MB WAY key
  assert.ok(verifyMbwayNotificationSignature('AAA-000000', 'order_45678', '11.55', '36jvlEhUYeknQ8PHKprR',
    'd7d2fd272233f0102e6dd0e50969025481cdfe3abb87cc3f135f74cfb47b2561'));
  assert.ok(!verifyMbwayNotificationSignature('AAA-000000', 'order_45678', '11.56', '36jvlEhUYeknQ8PHKprR',
    'd7d2fd272233f0102e6dd0e50969025481cdfe3abb87cc3f135f74cfb47b2561'));
});

test('Multibanco expiry days are rounded up to a value ifthenpay accepts', () => {
  const now = new Date('2026-10-20T10:00:00Z');
  assert.equal(multibancoExpiryDays(new Date('2026-10-20T20:00:00Z'), TZ, now), 0);
  assert.equal(multibancoExpiryDays(new Date('2026-10-21T10:00:00Z'), TZ, now), 1);
  assert.equal(multibancoExpiryDays(new Date('2026-12-30T10:00:00Z'), TZ, now), 90); // 71 days -> next allowed is 90
});

test('payment keys are encrypted at rest and tamper-evident', () => {
  const blob = encryptJson({ mbwayKey: 'ABC-123' });
  assert.ok(!blob.toString('utf8').includes('ABC-123'));
  assert.deepEqual(decryptJson(blob), { mbwayKey: 'ABC-123' });
  blob[blob.length - 1] ^= 1;
  assert.throws(() => decryptJson(blob));
});

test('password hashing', async () => {
  const h = await hashPassword('correct horse battery');
  assert.ok(await verifyPassword('correct horse battery', h));
  assert.ok(!(await verifyPassword('wrong', h)));
});
