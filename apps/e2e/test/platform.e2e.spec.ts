/**
 * platform.e2e.spec — the WHOLE platform, running, end to end.
 *
 * Every other test in this repo either stubs its upstreams or exercises one
 * service. This one boots the real gateway, identity, catalogue, pricing,
 * order and the customer BFF as SEPARATE PROCESSES against a real Postgres,
 * then drives a customer from "never heard of Besonc" to a delivered order.
 *
 * That distinction matters. The last three sessions found bugs that every
 * unit test passed:
 *
 *   • the gateway stripped route prefixes, so every login 404'd
 *   • the vendor BFF emitted keys the app does not read
 *   • idempotency was accepted, forwarded, and never enforced — three
 *     retries produced three orders and three charges
 *
 * None of those are visible without running the real thing. This file is
 * the regression net for that entire class of failure.
 *
 * Run: bash infra/scripts/test-platform.sh
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const ROOT = join(import.meta.dirname, '../../..');
const PGHOST = process.env.PLATFORM_PG_HOST ?? '127.0.0.1';
const PGPORT = process.env.PLATFORM_PG_PORT ?? '55450';
const dsn = (db: string) => `postgresql://postgres:pw@${PGHOST}:${PGPORT}/${db}`;

/** Ports well away from the dev stack so a running `make run` does not clash. */
const PORTS = {
  identity: 4801,
  catalogue: 4802,
  order: 4803,
  pricing: 4804,
  bffCustomer: 4901,
  gateway: 4900,
};

const GATEWAY = `http://127.0.0.1:${PORTS.gateway}`;

/** Distinct secrets: reusing one would let an access token be replayed. */
const ACCESS_SECRET = 'e2e-access-secret-at-least-32-characters-long';
const REFRESH_SECRET = 'e2e-refresh-secret-at-least-32-characters-diff';

const procs: ChildProcess[] = [];

interface ServiceSpec {
  name: string;
  main: string;
  port: number;
  db?: string;
  extra?: Record<string, string>;
}

const SERVICES: ServiceSpec[] = [
  { name: 'identity', main: 'apps/svc-identity/src/main.ts', port: PORTS.identity, db: 'identity',
    extra: {
      SVC_IDENTITY_PORT: String(PORTS.identity),
      EXPOSE_OTP_CODES: 'true',
      // A dozen sign-ins from one IP would trip the 20/hour ceiling.
      OTP_RELAX_LIMITS: 'true',
    } },
  { name: 'catalogue', main: 'apps/svc-catalogue/src/main.ts', port: PORTS.catalogue, db: 'catalogue',
    extra: { SVC_CATALOGUE_PORT: String(PORTS.catalogue) } },
  { name: 'order', main: 'apps/svc-order/src/main.ts', port: PORTS.order, db: 'orders',
    extra: { SVC_ORDER_PORT: String(PORTS.order) } },
  { name: 'pricing', main: 'apps/svc-pricing/src/main.ts', port: PORTS.pricing,
    extra: { SVC_PRICING_PORT: String(PORTS.pricing) } },
  { name: 'bff-customer', main: 'apps/bff-customer/src/main.ts', port: PORTS.bffCustomer,
    extra: { BFF_CUSTOMER_PORT: String(PORTS.bffCustomer) } },
  { name: 'gateway', main: 'apps/gateway/src/main.ts', port: PORTS.gateway,
    extra: { PORT: String(PORTS.gateway) } },
];

function launch(svc: ServiceSpec): ChildProcess {
  const child = spawn('npx', ['tsx', svc.main], {
    cwd: ROOT,
    // Own process group, so freezing or killing the service reaches the
    // ACTUAL server. `npx` spawns a child; signalling only the wrapper
    // leaves the real process running and outage tests silently pass.
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      JWT_ACCESS_SECRET: ACCESS_SECRET,
      JWT_REFRESH_SECRET: REFRESH_SECRET,
      ...(svc.db ? { DATABASE_URL: dsn(svc.db) } : { DATABASE_URL: '' }),
      // Every service must find its siblings on the SAME ports the gateway
      // routes to; a mismatch here is exactly the class of bug this file
      // exists to catch.
      SVC_IDENTITY_URL: `http://127.0.0.1:${PORTS.identity}`,
      SVC_CATALOGUE_URL: `http://127.0.0.1:${PORTS.catalogue}`,
      SVC_ORDER_URL: `http://127.0.0.1:${PORTS.order}`,
      SVC_PRICING_URL: `http://127.0.0.1:${PORTS.pricing}`,
      BFF_CUSTOMER_URL: `http://127.0.0.1:${PORTS.bffCustomer}`,
      ...svc.extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log: string[] = [];
  child.stdout?.on('data', (d) => log.push(String(d)));
  child.stderr?.on('data', (d) => log.push(String(d)));
  (child as any).__log = log;
  (child as any).__name = svc.name;
  return child;
}

async function waitForHealth(port: number, name: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return;
    } catch { /* still booting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  const proc = procs.find((p) => (p as any).__name === name);
  const log = ((proc as any)?.__log ?? []).join('').slice(-1500);
  throw new Error(`${name} never became healthy on :${port}\n--- log ---\n${log}`);
}

/* ------------------------------------------------------------------ */

let admin: pg.Pool;
let storeId = '';
let itemId = '';

before(async () => {
  admin = new pg.Pool({ connectionString: dsn('postgres') });

  // Fresh databases every run: a test that only passes on a dirty database
  // is not a test.
  for (const db of ['identity', 'catalogue', 'orders']) {
    await admin.query(`DROP DATABASE IF EXISTS ${db}`).catch(() => {});
    await admin.query(`CREATE DATABASE ${db}`);
  }

  const migrate = async (db: string, file: string) => {
    const p = new pg.Pool({ connectionString: dsn(db) });
    try {
      await p.query(readFileSync(join(ROOT, file), 'utf8'));
    } finally {
      await p.end();
    }
  };
  await migrate('identity', 'apps/svc-identity/migrations/001_identity.sql');
  await migrate('catalogue', 'apps/svc-catalogue/migrations/001_catalogue.sql');
  await migrate('orders', 'apps/svc-order/migrations/001_orders.sql');
  await migrate('orders', 'apps/svc-order/migrations/002_idempotency.sql');

  // Seed one approved vendor with one dish.
  const cat = new pg.Pool({ connectionString: dsn('catalogue') });
  try {
    const alwaysOpen = JSON.stringify(Object.fromEntries(
      ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
        .map((d) => [d, { open: '00:00', close: '23:59' }]),
    ));
    const s = await cat.query<{ id: string }>(
      `INSERT INTO stores (owner_id, service_type, name, latitude, longitude,
                           phone, status, operating_hours)
       VALUES (gen_random_uuid(), 'food', 'Auntie Muni Waakye',
               5.6037, -0.1870, '+233244000001', 'approved', $1::jsonb)
       RETURNING id`, [alwaysOpen],
    );
    storeId = s.rows[0]!.id;

    const i = await cat.query<{ id: string }>(
      `INSERT INTO items (store_id, name, base_price_pesewas, is_available)
       VALUES ($1, 'Jollof Rice', 3500, true) RETURNING id`, [storeId],
    );
    itemId = i.rows[0]!.id;
  } finally {
    await cat.end();
  }

  // Boot every service, then wait for all of them.
  for (const svc of SERVICES) procs.push(launch(svc));
  for (const svc of SERVICES) await waitForHealth(svc.port, svc.name);
});

/** Signal the whole process group, not just the npx wrapper. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

after(async () => {
  for (const p of procs) signalGroup(p, 'SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  for (const p of procs) signalGroup(p, 'SIGKILL');
  await admin?.end().catch(() => {});
});

/* ------------------------------------------------------------------ */

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${GATEWAY}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

async function signIn(phone: string) {
  const req = await api('/api/auth/otp/request', {
    method: 'POST', body: JSON.stringify({ phone }),
  });
  const otp = await req.json() as any;
  assert.equal(req.status, 201, `OTP request failed: ${JSON.stringify(otp)}`);
  assert.ok(otp.debugCode, 'EXPOSE_OTP_CODES must be on for this suite');

  const ver = await api('/api/auth/otp/verify', {
    method: 'POST',
    body: JSON.stringify({ phone, code: otp.debugCode, role: 'customer' }),
  });
  const body = await ver.json() as any;
  assert.equal(ver.status, 201, `verify failed: ${JSON.stringify(body)}`);
  return {
    token: body.tokens.accessToken as string,
    refresh: body.tokens.refreshToken as string,
    userId: body.user.id as string,
    isNew: body.isNewUser as boolean,
  };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/* ------------------------------------------------------------------ */

describe('the platform is actually wired together', () => {
  test('every service reports healthy', async () => {
    for (const svc of SERVICES) {
      const res = await fetch(`http://127.0.0.1:${svc.port}/health`);
      assert.equal(res.status, 200, `${svc.name} is not healthy`);
    }
  });

  test('the gateway rewrites prefixes to what services actually serve', async () => {
    // The bug: clients call /api/auth/otp/request, identity serves
    // /auth/otp/request. Stripping the whole prefix asked for /otp/request
    // and 404'd — EVERY login was broken and no unit test saw it.
    const res = await api('/api/auth/otp/request', {
      method: 'POST', body: JSON.stringify({ phone: '0244000111' }),
    });
    assert.equal(res.status, 201);
  });

  test('an unknown route is a clean 404, not a hang', async () => {
    const res = await api('/api/nonsense');
    assert.equal(res.status, 404);
  });
});

describe('sign-in through the whole chain', () => {
  test('a new customer gets tokens and an account in Postgres', async () => {
    const s = await signIn('0244100001');

    assert.equal(s.isNew, true);
    assert.equal(s.token.split('.').length, 3, 'a real JWT');

    const idp = new pg.Pool({ connectionString: dsn('identity') });
    try {
      const r = await idp.query(
        'SELECT phone, role, phone_verified FROM users WHERE id = $1', [s.userId],
      );
      assert.equal(r.rows[0]!.phone, '+233244100001');
      assert.equal(r.rows[0]!.phone_verified, true);
    } finally {
      await idp.end();
    }
  });

  test('the SAME token is accepted by a different service', async () => {
    // identity mints it; the BFF verifies it. If the two disagree about the
    // secret or the algorithm, this is where it shows.
    const s = await signIn('0244100002');
    const res = await api('/api/customer/home', { headers: auth(s.token) });
    assert.equal(res.status, 200, 'cross-service token verification is broken');
  });

  test('a forged x-user-id header does NOT authenticate', async () => {
    const res = await api('/api/customer/home', {
      headers: { 'x-user-id': 'admin', 'x-gateway-verified': 'true' },
    });
    assert.equal(res.status, 401,
      'services trust x-user-* BECAUSE the gateway sets them — a client copy '
      + 'must be stripped');
  });

  test('a customer token is refused on a vendor route', async () => {
    const s = await signIn('0244100003');
    const res = await api('/api/vendor/queue', { headers: auth(s.token) });
    assert.ok([401, 403].includes(res.status), `expected 401/403, got ${res.status}`);
  });
});

describe('discovery reads the real catalogue', () => {
  test('the home screen shows a store seeded in Postgres', async () => {
    const s = await signIn('0244100010');
    await api('/api/users/me/addresses', {
      method: 'POST', headers: auth(s.token),
      body: JSON.stringify({
        latitude: 5.5560, longitude: -0.1821,
        label: 'Home', landmark: 'behind the MTN mast',
      }),
    });

    const home = await (await api('/api/customer/home', { headers: auth(s.token) }))
      .json() as any;

    assert.equal(home.deliveringTo.landmark, 'behind the MTN mast');
    const names = home.popularNearYou.map((c: any) => c.name);
    assert.ok(names.includes('Auntie Muni Waakye'),
      `seeded store missing from discovery: ${JSON.stringify(names)}`);
  });

  test('the store page returns the real menu', async () => {
    const s = await signIn('0244100011');
    const page = await (await api(`/api/customer/stores/${storeId}`,
      { headers: auth(s.token) })).json() as any;

    assert.equal(page.store.name, 'Auntie Muni Waakye');
    assert.equal(page.categories[0].items[0].name, 'Jollof Rice');
    assert.equal(page.categories[0].items[0].basePricePesewas, '3500');
    assert.equal(typeof page.categories[0].items[0].available, 'boolean',
      'the Dart model reads "available", not "isAvailable"');
  });
});

describe('checkout, priced by the real pricing service', () => {
  let token = '';

  before(async () => {
    const s = await signIn('0244100020');
    token = s.token;
    await api('/api/users/me/addresses', {
      method: 'POST', headers: auth(token),
      body: JSON.stringify({ latitude: 5.5560, longitude: -0.1821, label: 'Home' }),
    });
  });

  const cart = () => ({
    storeId,
    lines: [{ itemId, quantity: 2, addonOptionIds: [] }],
  });

  test('the quote is computed from a real distance', async () => {
    const q = await (await api('/api/customer/checkout/quote', {
      method: 'POST', headers: auth(token), body: JSON.stringify(cart()),
    })).json() as any;

    // 2 x GHS 35.00 straight from the catalogue.
    assert.equal(q.itemTotalPesewas, '7000');
    // Accra Central -> Osu is ~5.3km, which lands in the 3-7km tier.
    assert.ok(Number(q.distanceMetres) > 4000 && Number(q.distanceMetres) < 7000,
      `implausible distance: ${q.distanceMetres}`);
    assert.equal(
      BigInt(q.totalPesewas),
      BigInt(q.itemTotalPesewas) + BigInt(q.deliveryFeePesewas)
        + BigInt(q.serviceFeePesewas),
      'the total must be the sum of its parts',
    );
  });

  test('THE SERVER REPRICES — a lying client is ignored', async () => {
    const q = await (await api('/api/customer/checkout/quote', {
      method: 'POST', headers: auth(token),
      body: JSON.stringify({
        storeId,
        lines: [{ itemId, quantity: 2, pricePesewas: '1', linePesewas: '1' }],
      }),
    })).json() as any;

    assert.equal(q.itemTotalPesewas, '7000',
      'prices come from the catalogue, never from the request body');
  });

  test('COD is refused for a new customer above GHS 50', async () => {
    const q = await (await api('/api/customer/checkout/quote', {
      method: 'POST', headers: auth(token), body: JSON.stringify(cart()),
    })).json() as any;

    assert.equal(q.codEligible, false);
    assert.match(q.codReason, /GHS 50|cash/i);

    const res = await api('/api/customer/checkout', {
      method: 'POST',
      headers: { ...auth(token), 'idempotency-key': 'e2e-cod-refused' },
      body: JSON.stringify({ ...cart(), paymentIntent: 'cod' }),
    });
    assert.equal(res.status, 422, 'the server must refuse what it just said it would');
  });

  test('a prepaid order is created and persisted', async () => {
    const res = await api('/api/customer/checkout', {
      method: 'POST',
      headers: { ...auth(token), 'idempotency-key': 'e2e-prepaid-1' },
      body: JSON.stringify({ ...cart(), paymentIntent: 'prepaid' }),
    });
    const body = await res.json() as any;

    assert.equal(res.status, 201, JSON.stringify(body));
    assert.ok(body.orderId);
    assert.equal(body.requiresApproval, true, 'momo needs a handset prompt');

    const op = new pg.Pool({ connectionString: dsn('orders') });
    try {
      const r = await op.query(
        'SELECT state, total_pesewas FROM orders WHERE id = $1', [body.orderId],
      );
      assert.equal(r.rows[0]!.state, 'pending_payment');
      assert.equal(String(r.rows[0]!.total_pesewas), body.totalPesewas);
    } finally {
      await op.end();
    }
  });

  test('IDEMPOTENCY: five retries produce ONE order', async () => {
    const op = new pg.Pool({ connectionString: dsn('orders') });
    try {
      const before = await op.query<{ n: string }>('SELECT count(*) n FROM orders');

      const refs = new Set<string>();
      for (let i = 0; i < 5; i++) {
        const r = await api('/api/customer/checkout', {
          method: 'POST',
          headers: { ...auth(token), 'idempotency-key': 'e2e-retry-storm' },
          body: JSON.stringify({ ...cart(), paymentIntent: 'prepaid' }),
        });
        const b = await r.json() as any;
        assert.equal(r.status, 201, JSON.stringify(b));
        refs.add(b.humanRef);
      }

      const after = await op.query<{ n: string }>('SELECT count(*) n FROM orders');
      const created = Number(after.rows[0]!.n) - Number(before.rows[0]!.n);

      assert.equal(created, 1,
        'this is the bug that reached the running stack: a timed-out POST is '
        + 'routine on Ghanaian mobile data, and each retry charged again');
      assert.equal(refs.size, 1, 'every retry must return the SAME order');
    } finally {
      await op.end();
    }
  });

  test('the same key with a DIFFERENT cart is a 409, not a wrong order', async () => {
    const res = await api('/api/customer/checkout', {
      method: 'POST',
      headers: { ...auth(token), 'idempotency-key': 'e2e-retry-storm' },
      body: JSON.stringify({
        storeId,
        lines: [{ itemId, quantity: 9, addonOptionIds: [] }],
        paymentIntent: 'prepaid',
      }),
    });
    const body = await res.json() as any;

    assert.equal(res.status, 409,
      'a 5xx would tell the app to retry something that can never succeed');
    assert.match(body.detail ?? body.title, /Idempotency-Key/i);
  });

  test('an item that left the menu is refused', async () => {
    const res = await api('/api/customer/checkout/quote', {
      method: 'POST', headers: auth(token),
      body: JSON.stringify({
        storeId,
        lines: [{ itemId: '00000000-0000-4000-8000-000000000999', quantity: 1 }],
      }),
    });
    assert.equal(res.status, 422);
  });
});

describe('the order lifecycle reaches settlement', () => {
  test('placed -> delivered, splitting to the canonical figures', async () => {
    const s = await signIn('0244100030');
    await api('/api/users/me/addresses', {
      method: 'POST', headers: auth(s.token),
      body: JSON.stringify({ latitude: 5.5560, longitude: -0.1821, label: 'Home' }),
    });

    const placed = await (await api('/api/customer/checkout', {
      method: 'POST',
      headers: { ...auth(s.token), 'idempotency-key': 'e2e-lifecycle' },
      body: JSON.stringify({
        storeId, lines: [{ itemId, quantity: 2 }], paymentIntent: 'prepaid',
      }),
    })).json() as any;

    const orderId = placed.orderId as string;
    const direct = `http://127.0.0.1:${PORTS.order}`;

    const raise = async (event: string) => {
      const r = await fetch(`${direct}/orders/${orderId}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event }),
      });
      const b = await r.json() as any;
      assert.equal(r.status, 201, `${event} failed: ${JSON.stringify(b)}`);
      return b.to as string;
    };

    assert.equal(await raise('payment_confirmed'), 'placed');
    assert.equal(await raise('vendor_accept'), 'vendor_accepted');
    assert.equal(await raise('vendor_ready'), 'ready_for_pickup');
    assert.equal(await raise('rider_assign'), 'rider_assigned');
    assert.equal(await raise('rider_arrive_vendor'), 'rider_at_vendor');
    assert.equal(await raise('rider_pickup'), 'picked_up');
    assert.equal(await raise('rider_arrive'), 'arrived');
    assert.equal(await raise('rider_deliver'), 'delivered');

    const op = new pg.Pool({ connectionString: dsn('orders') });
    try {
      const r = await op.query(
        `SELECT item_total_pesewas, delivery_fee_pesewas, service_fee_pesewas,
                total_pesewas, vendor_amount_pesewas, rider_amount_pesewas,
                platform_amount_pesewas
           FROM orders WHERE id = $1`, [orderId],
      );
      const o = r.rows[0]!;

      // The DB constraint already enforces this, but asserting it here says
      // WHY it matters: an order that settles to the wrong total is money
      // appearing from nowhere.
      assert.equal(
        BigInt(o.vendor_amount_pesewas) + BigInt(o.rider_amount_pesewas)
          + BigInt(o.platform_amount_pesewas),
        BigInt(o.total_pesewas),
        'the three-way split must equal the total exactly',
      );

      // Food commission is 15% (PDF §6): vendor keeps 85% of the items.
      assert.equal(
        BigInt(o.vendor_amount_pesewas),
        (BigInt(o.item_total_pesewas) * 85n) / 100n,
      );
      // The rider is paid the delivery fee, whatever the distance was.
      assert.equal(BigInt(o.rider_amount_pesewas), BigInt(o.delivery_fee_pesewas));

      // Outbox rows exist for the transitions other services react to.
      const outbox = await op.query<{ event_type: string }>(
        'SELECT DISTINCT event_type FROM outbox WHERE aggregate_id = $1', [orderId],
      );
      const events = outbox.rows.map((x) => x.event_type);
      for (const expected of ['order.placed', 'order.delivered']) {
        assert.ok(events.includes(expected),
          `outbox is missing ${expected}; nothing downstream would ever hear`);
      }
    } finally {
      await op.end();
    }
  });

  test('an illegal transition is refused', async () => {
    const s = await signIn('0244100031');
    await api('/api/users/me/addresses', {
      method: 'POST', headers: auth(s.token),
      body: JSON.stringify({ latitude: 5.5560, longitude: -0.1821, label: 'Home' }),
    });
    const placed = await (await api('/api/customer/checkout', {
      method: 'POST',
      headers: { ...auth(s.token), 'idempotency-key': 'e2e-illegal' },
      body: JSON.stringify({
        storeId, lines: [{ itemId, quantity: 1 }], paymentIntent: 'prepaid',
      }),
    })).json() as any;

    // Straight to delivered, skipping the entire kitchen.
    const res = await fetch(
      `http://127.0.0.1:${PORTS.order}/orders/${placed.orderId}/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'rider_deliver' }),
      },
    );
    assert.ok(res.status >= 400,
      'a delivered order that was never cooked would settle money to a vendor '
      + 'who did nothing');
  });
});

describe('degradation', () => {
  test('the home screen survives the catalogue being unreachable', async () => {
    const s = await signIn('0244100040');
    await api('/api/users/me/addresses', {
      method: 'POST', headers: auth(s.token),
      body: JSON.stringify({ latitude: 5.5560, longitude: -0.1821, label: 'Home' }),
    });

    const cat = procs.find((p) => (p as any).__name === 'catalogue')!;
    signalGroup(cat, 'SIGSTOP');   // frozen, not dead: accepts, never answers
    // SIGSTOP is asynchronous. Without settling first, the catalogue can
    // finish an in-flight request and the test sees a healthy response —
    // which looks like broken degradation but is just a race in the test.
    await new Promise((r) => setTimeout(r, 500));
    try {
      const started = Date.now();
      const res = await api('/api/customer/home', { headers: auth(s.token) });
      const body = await res.json() as any;
      const elapsed = Date.now() - started;

      assert.equal(res.status, 200,
        'a customer must still see their orders when discovery is down');
      assert.deepEqual(body.popularNearYou, [],
        'a frozen catalogue must yield no stores, not a hang');
      assert.ok(body.degraded?.includes('stores'),
        'the app is told the screen is partial rather than shown an empty world');
      assert.ok(elapsed < 10_000,
        `took ${elapsed}ms — the BFF must give up on an upstream long before `
        + 'the phone gives up on the BFF');
    } finally {
      signalGroup(cat, 'SIGCONT');
      // Let it drain the queued request before the next test runs.
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  test('a slow upstream times out instead of hanging the phone', async () => {
    const s = await signIn('0244100041');
    const order = procs.find((p) => (p as any).__name === 'order')!;
    signalGroup(order, 'SIGSTOP');
    try {
      const started = Date.now();
      const res = await api('/api/customer/home', { headers: auth(s.token) });
      const elapsed = Date.now() - started;

      assert.equal(res.status, 200);
      assert.ok(elapsed < 12_000,
        `took ${elapsed}ms — a phone would have given up first`);
    } finally {
      signalGroup(order, 'SIGCONT');
    }
  });
});
