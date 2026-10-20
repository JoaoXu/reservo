// Runs against a real Postgres (DATABASE_URL, default reservo_test) and the
// real HTTP server. The ifthenpay API is replaced by a fake `fetch`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_URL ??= 'postgres://postgres@127.0.0.1:5432/reservo_test';
process.env.LOG_LEVEL = 'error';
process.env.INLINE_WORKER = 'false';

const { sql, closeDb } = await import('../src/db.ts');
const { migrate } = await import('../scripts/migrate.ts');
const { seedDemo } = await import('../scripts/seed-demo.ts');
const { createAppServer } = await import('../src/server.ts');
const { createBooking, BookingError, manageTokenFor } = await import('../src/domain/bookings.ts');
const { tenantById, sealPaymentKeys, invalidateTenantCache } = await import('../src/domain/tenants.ts');
const { runJobs } = await import('../src/domain/jobs.ts');
const { zonedToUtc, addDays, localDateStr } = await import('../src/lib/time.ts');
const { hmacSha256Hex } = await import('../src/lib/crypto.ts');

let base = '';
let server: ReturnType<typeof createAppServer>;
let tenantId = '';
const realFetch = globalThis.fetch;

// A weekday at least 3 days out where every demo therapist works (Thursday).
function nextThursday(): string {
  let d = addDays(localDateStr(new Date(), 'Europe/Lisbon'), 3);
  while (new Date(d + 'T12:00:00Z').getUTCDay() !== 4) d = addDays(d, 1);
  return d;
}

before(async () => {
  // Fresh schema for each run
  await sql.unsafe('drop schema public cascade; create schema public;');
  await migrate();
  tenantId = await seedDemo(['localhost']);
  server = createAppServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((r) => server.close(r));
  await closeDb();
});

async function ids() {
  const [svc] = await sql<{ id: string }[]>`select id from services where tenant_id = ${tenantId} and name_pt = 'Massagem de relaxamento'`;
  const [ines] = await sql<{ id: string }[]>`select id from staff where tenant_id = ${tenantId} and name = 'Inês Carvalho'`;
  return { serviceId: svc.id, ines: ines.id };
}

const customer = (phone: string) => ({ name: 'Teste', phone, email: null, locale: 'pt' as const, note: '', marketingConsent: false });

test('home and booking pages render with security headers', async () => {
  const r = await realFetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  const body = await r.text();
  assert.match(body, /Maré/);
  assert.equal((await realFetch(base + '/marcar')).status, 200);
  assert.equal((await realFetch(base + '/nope')).status, 404);
});

test('a therapist can never be double-booked, even with concurrent requests', async () => {
  const tenant = (await tenantById(tenantId))!;
  const { serviceId, ines } = await ids();
  const start = zonedToUtc(nextThursday(), 13 * 60, 'Europe/Lisbon'); // Inês works 12:00-20:00 on Thursdays
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
    createBooking(tenant, { serviceId, staffId: ines, start, customer: customer(`+3519100000${10 + i}`), source: 'online', payment: 'studio' })));
  const ok = attempts.filter((a) => a.status === 'fulfilled');
  assert.equal(ok.length, 1, 'exactly one booking wins');
  for (const a of attempts) if (a.status === 'rejected') assert.ok(a.reason instanceof BookingError && a.reason.code === 'slot_unavailable');
});

test('"any therapist" spreads concurrent bookings across free therapists', async () => {
  const tenant = (await tenantById(tenantId))!;
  const { serviceId } = await ids();
  const start = zonedToUtc(nextThursday(), 15 * 60, 'Europe/Lisbon'); // all three work at 15:00 Thursday
  const attempts = await Promise.allSettled(Array.from({ length: 5 }, (_, i) =>
    createBooking(tenant, { serviceId, staffId: null, start, customer: customer(`+3519200000${10 + i}`), source: 'online', payment: 'studio' })));
  const ok = attempts.filter((a) => a.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof createBooking>>>[];
  assert.equal(ok.length, 3, 'three therapists, three bookings');
  assert.equal(new Set(ok.map((o) => o.value.booking.staff_id)).size, 3);
});

test('online booking through the API with a simulated MB WAY payment', async () => {
  const { serviceId } = await ids();
  const date = nextThursday();
  const slots = await (await realFetch(`${base}/api/slots?service=${serviceId}&date=${date}`)).json() as { slots: { start: string; methods: string[] }[] };
  assert.ok(slots.slots.length > 0);
  const slot = slots.slots.find((s) => s.methods.includes('mbway'))!;
  const res = await realFetch(base + '/api/bookings', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ service: serviceId, start: slot.start, name: 'Ana Silva', phone: '912 111 222', privacy: true, payment: 'mbway', locale: 'pt' }),
  });
  assert.equal(res.status, 201);
  const created = await res.json() as { ref: string; status: string; next: string };
  assert.equal(created.status, 'pending_payment');

  // The slot is held for that therapist while the customer approves the payment.
  const before = (slots.slots as unknown as { start: string; staff: string[] }[]).find((s) => s.start === slot.start)!.staff.length;
  const after = await (await realFetch(`${base}/api/slots?service=${serviceId}&date=${date}`)).json() as { slots: { start: string; staff: string[] }[] };
  const same = after.slots.find((s) => s.start === slot.start);
  assert.equal(same ? same.staff.length : 0, before - 1);

  // The mock gateway approves after a few seconds; polling picks it up.
  const token = new URL(created.next, base).searchParams.get('t')!;
  await sql`update payments set created_at = now() - interval '10 seconds' where booking_id = (select id from bookings where ref = ${created.ref})`;
  const st = await (await realFetch(`${base}/api/reserva/${created.ref}/estado?t=${token}`)).json() as { booking: string };
  assert.equal(st.booking, 'confirmed');

  // Wrong token: not found
  assert.equal((await realFetch(`${base}/reserva/${created.ref}?t=wrong`)).status, 404);
  assert.equal((await realFetch(`${base}/reserva/${created.ref}?t=${token}`)).status, 200);
  assert.equal((await realFetch(`${base}/reserva/${created.ref}/calendario.ics?t=${token}`)).headers.get('content-type'), 'text/calendar; charset=utf-8');
});

test('cross-site POSTs are refused', async () => {
  const res = await realFetch(base + '/api/bookings', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}',
  });
  assert.equal(res.status, 403);
});

test('ifthenpay: MB WAY request, callback with anti-phishing key, amount check, idempotency', async () => {
  const keys = { mbwayKey: 'ABC-123456', mbKey: 'MBK-1', antiPhishingKey: 'secret-key-123' };
  await sql`update tenants set payment_provider = 'ifthenpay', status = 'active', payment_secrets = ${sealPaymentKeys(keys)} where id = ${tenantId}`;
  invalidateTenantCache();
  const sent: { url: string; body: Record<string, string> }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://api.ifthenpay.com')) return realFetch(input, init);
    sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
    if (url.endsWith('/spg/payment/mbway')) {
      const b = JSON.parse(String(init!.body));
      return new Response(JSON.stringify({ Amount: b.amount, Message: 'Pending', OrderId: b.orderId, RequestId: 'REQ123', Status: '000' }), { status: 200 });
    }
    if (url.includes('/spg/payment/mbway/status')) return new Response(JSON.stringify({ Status: '123', Message: 'Pending' }), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  try {
    const tenant = (await tenantById(tenantId))!;
    const { serviceId, ines } = await ids();
    const start = zonedToUtc(addDays(nextThursday(), 7), 18 * 60, 'Europe/Lisbon');
    const created = await createBooking(tenant, { serviceId, staffId: ines, start, customer: customer('+351913333444'), source: 'online', payment: 'mbway' });
    assert.equal(created.booking.status, 'pending_payment');
    const req = sent.find((s) => s.url.endsWith('/spg/payment/mbway'))!;
    assert.equal(req.body.mbWayKey, 'ABC-123456');
    assert.equal(req.body.mobileNumber, '913333444');
    assert.equal(req.body.amount, '16.50'); // 30% of €55
    assert.ok(req.body.orderId.length <= 15);
    const orderId = req.body.orderId;

    const hook = (q: string) => realFetch(`${base}/hooks/ifthenpay/${tenantId}?${q}`);
    assert.equal((await hook(`key=wrong&orderId=${orderId}&amount=16.50&requestId=REQ123`)).status, 403);
    // Wrong amount: acknowledged but ignored
    assert.equal((await hook(`key=secret-key-123&orderId=${orderId}&amount=1.00&requestId=REQ123`)).status, 200);
    let [b] = await sql<{ status: string; paid_cents: number }[]>`select status, paid_cents from bookings where id = ${created.booking.id}`;
    assert.equal(b.status, 'pending_payment');
    // Correct callback, delivered twice (ifthenpay retries): applied once
    assert.equal((await hook(`key=secret-key-123&orderId=${orderId}&amount=16.50&requestId=REQ123&payment_datetime=21-10-2026 10:00:00`)).status, 200);
    assert.equal((await hook(`key=secret-key-123&orderId=${orderId}&amount=16.50&requestId=REQ123&payment_datetime=21-10-2026 10:00:00`)).status, 200);
    [b] = await sql<{ status: string; paid_cents: number }[]>`select status, paid_cents from bookings where id = ${created.booking.id}`;
    assert.equal(b.status, 'confirmed');
    assert.equal(b.paid_cents, 1650);

    // Signed MB WAY notification for a declined request on another booking
    const start2 = zonedToUtc(addDays(nextThursday(), 7), 16 * 60, 'Europe/Lisbon');
    const c2 = await createBooking(tenant, { serviceId, staffId: ines, start: start2, customer: customer('+351913333555'), source: 'online', payment: 'mbway' });
    const [p2] = await sql<{ order_id: string }[]>`select order_id from payments where booking_id = ${c2.booking.id}`;
    const body = JSON.stringify({ RequestId: 'REQ123', Status: '020', Message: 'Declined by user' });
    const bad = await realFetch(`${base}/hooks/ifthenpay/${tenantId}/mbway-notification`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ifthenpay-signature': 'nope' }, body });
    assert.equal(bad.status, 403);
    // Both payments share REQ123 in this fake; the handler picks one, so sign for whichever it finds
    const [found] = await sql<{ order_id: string; amount_cents: number }[]>`select order_id, amount_cents from payments where tenant_id = ${tenantId} and provider_request_id = 'REQ123' and method = 'mbway'`;
    const sig = hmacSha256Hex('ABC-123456', `${found.order_id}${(found.amount_cents / 100).toFixed(2)}REQ123`);
    const good = await realFetch(`${base}/hooks/ifthenpay/${tenantId}/mbway-notification`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ifthenpay-signature': sig }, body });
    assert.equal(good.status, 200);
    void p2;
  } finally {
    globalThis.fetch = realFetch;
    await sql`update tenants set payment_provider = 'mock', status = 'demo' where id = ${tenantId}`;
    invalidateTenantCache();
  }
});

test('expired holds are released and a late payment re-instates the booking if the slot is still free', async () => {
  const tenant = (await tenantById(tenantId))!;
  const { serviceId, ines } = await ids();
  const start = zonedToUtc(addDays(nextThursday(), 14), 18 * 60, 'Europe/Lisbon');
  const created = await createBooking(tenant, { serviceId, staffId: ines, start, customer: customer('+351914444555'), source: 'online', payment: 'mbway' });
  await sql`update bookings set hold_expires_at = now() - interval '1 minute' where id = ${created.booking.id}`;
  await sql`update payments set created_at = now() - interval '30 minutes' where booking_id = ${created.booking.id}`;
  await runJobs();
  let [b] = await sql<{ status: string; cancel_reason: string }[]>`select status, cancel_reason from bookings where id = ${created.booking.id}`;
  assert.equal(b.status, 'cancelled');
  assert.equal(b.cancel_reason, 'hold_expired');

  const { settlePayment } = await import('../src/domain/events.ts');
  const [p] = await sql`select * from payments where booking_id = ${created.booking.id}`;
  await settlePayment(p as never, 'paid', 'late');
  [b] = await sql`select status, cancel_reason from bookings where id = ${created.booking.id}`;
  assert.equal(b.status, 'confirmed');
});

test('customers can cancel inside the window with their link; others cannot', async () => {
  const tenant = (await tenantById(tenantId))!;
  const { serviceId } = await ids();
  const start = zonedToUtc(nextThursday(), 11 * 60, 'Europe/Lisbon');
  const created = await createBooking(tenant, { serviceId, staffId: null, start, customer: customer('+351915555666'), source: 'online', payment: 'studio' });
  const token = manageTokenFor(created.booking.id);
  const noOrigin = await realFetch(`${base}/reserva/${created.booking.ref}/cancelar?t=${token}`, { method: 'POST', redirect: 'manual' });
  assert.equal(noOrigin.status, 403);
  const res = await realFetch(`${base}/reserva/${created.booking.ref}/cancelar?t=${token}`, { method: 'POST', redirect: 'manual', headers: { origin: base } });
  assert.equal(res.status, 303);
  const [b] = await sql<{ status: string }[]>`select status from bookings where id = ${created.booking.id}`;
  assert.equal(b.status, 'cancelled');
});

test('admin requires login, CSRF token, and keeps studios apart', async () => {
  const r = await realFetch(base + '/admin', { redirect: 'manual' });
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location') ?? '', /\/admin\/login/);
  const login = await realFetch(base + '/admin/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: 'email=demo%40reservo.pt&password=mare-demo-2026',
  });
  assert.equal(login.status, 303);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  assert.match(cookie, /^rsid=/);
  assert.equal((await realFetch(base + '/admin', { headers: { cookie } })).status, 200);
  // POST without the CSRF token is refused
  const noCsrf = await realFetch(base + '/admin/time-off', { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: 'from_date=2026-12-24&to_date=2026-12-25' });
  assert.equal(noCsrf.status, 403);

  // A second studio's session can't see the first studio's dashboard.
  await sql`insert into tenants (slug, name) values ('outro', 'Outro')`;
  await sql`insert into tenant_domains (domain, tenant_id) select 'outro.localhost', id from tenants where slug = 'outro'`;
  const { request } = await import('node:http');
  const status = await new Promise<number>((resolve, reject) => {
    const u = new URL(base);
    request({ host: '127.0.0.1', port: u.port, path: '/admin', headers: { cookie, host: 'outro.localhost' } }, (res) => { res.resume(); resolve(res.statusCode!); }).on('error', reject).end();
  });
  assert.equal(status, 303);

  const wrong = await realFetch(base + '/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: 'email=demo%40reservo.pt&password=nope',
  });
  assert.equal(wrong.status, 401);
});
