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
  bffVendor: 4902,
  bffRider: 4903,
  dispatch: 4805,
  tracking: 4806,
  payment: 4807,
  media: 4808,
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
  /**
   * Which lanes need this service running.
   *
   * MEASURED: each tsx service holds ~230MB resident — and that is NOT V8
   * old-space, it is the esbuild compiler and the Node binary, so
   * --max-old-space-size does not shrink it (capping to 160MB just starves
   * the compiler until it dies mid-boot). Twelve services is ~2.7GB against
   * a ~2GB box, so they cannot all run at once and no amount of staggering
   * changes that: once booted, they all stay resident.
   *
   * So each lane boots only what it actually exercises. Run the lanes in
   * sequence and the whole platform is still covered end to end, with a
   * peak of six services instead of twelve.
   */
  lanes: Lane[];
}

/** Test groups, each with its own service set. */
export type Lane = 'core' | 'vendor' | 'rider';

const ALL_LANES: Lane[] = ['core', 'vendor', 'rider'];

/**
 * Which lane to run. Unset means all of them in one process, which is the
 * right default on a machine with enough RAM and is what CI should do.
 */
const LANE = (process.env.E2E_LANE as Lane | undefined) ?? null;
const ACTIVE_LANES: Lane[] = LANE ? [LANE] : ALL_LANES;

function inLane(spec: { lanes: Lane[] }): boolean {
  return spec.lanes.some((l) => ACTIVE_LANES.includes(l));
}

/** Skip a whole suite when its lane is not the one being run. */
function laneSkip(lane: Lane): false | string {
  return ACTIVE_LANES.includes(lane) ? false : `lane ${lane} not selected`;
}

const SERVICES: ServiceSpec[] = [
  { name: 'identity', main: 'apps/svc-identity/src/main.ts', port: PORTS.identity, db: 'identity',
    extra: {
      SVC_IDENTITY_PORT: String(PORTS.identity),
      EXPOSE_OTP_CODES: 'true',
      // A dozen sign-ins from one IP would trip the 20/hour ceiling.
      OTP_RELAX_LIMITS: 'true',
    },
    lanes: ['core', 'vendor', 'rider'] },
  { name: 'catalogue', main: 'apps/svc-catalogue/src/main.ts', port: PORTS.catalogue, db: 'catalogue',
    extra: { SVC_CATALOGUE_PORT: String(PORTS.catalogue) },
    lanes: ['core', 'vendor'] },
  { name: 'order', main: 'apps/svc-order/src/main.ts', port: PORTS.order, db: 'orders',
    extra: { SVC_ORDER_PORT: String(PORTS.order) },
    lanes: ['core', 'vendor', 'rider'] },
  { name: 'pricing', main: 'apps/svc-pricing/src/main.ts', port: PORTS.pricing,
    extra: { SVC_PRICING_PORT: String(PORTS.pricing) },
    // The vendor lane places a REAL order through the customer BFF rather
    // than inserting one — that is the point of "a real order appears in the
    // vendor queue" — so it needs the whole checkout path.
    lanes: ['core', 'vendor'] },
  { name: 'bff-customer', main: 'apps/bff-customer/src/main.ts', port: PORTS.bffCustomer,
    extra: { BFF_CUSTOMER_PORT: String(PORTS.bffCustomer) },
    lanes: ['core', 'vendor'] },
  { name: 'bff-vendor', main: 'apps/bff-vendor/src/main.ts', port: PORTS.bffVendor,
    extra: { BFF_VENDOR_PORT: String(PORTS.bffVendor) },
    lanes: ['vendor'] },
  { name: 'payment', main: 'apps/svc-payment/src/main.ts', port: PORTS.payment, db: 'payment',
    extra: { SVC_PAYMENT_PORT: String(PORTS.payment) },
    lanes: ['core', 'vendor', 'rider'] },
  { name: 'media', main: 'apps/svc-media/src/main.ts', port: PORTS.media,
    extra: { SVC_MEDIA_PORT: String(PORTS.media) },
    lanes: ['rider'] },
  { name: 'dispatch', main: 'apps/svc-dispatch/src/main.ts', port: PORTS.dispatch, db: 'dispatch',
    extra: { SVC_DISPATCH_PORT: String(PORTS.dispatch) },
    lanes: ['rider'] },
  { name: 'tracking', main: 'apps/svc-tracking/src/main.ts', port: PORTS.tracking, db: 'tracking',
    extra: { SVC_TRACKING_PORT: String(PORTS.tracking) },
    lanes: ['core', 'rider'] },
  { name: 'bff-rider', main: 'apps/bff-rider/src/main.ts', port: PORTS.bffRider,
    extra: { BFF_RIDER_PORT: String(PORTS.bffRider) },
    lanes: ['rider'] },
  { name: 'gateway', main: 'apps/gateway/src/main.ts', port: PORTS.gateway,
    extra: {
      PORT: String(PORTS.gateway),
      // Dozens of sign-ins from one IP would trip the 30/minute anonymous
      // ceiling. Ignored when NODE_ENV=production.
      RATE_LIMIT_SCALE: '100',
    },
    lanes: ['core', 'vendor', 'rider'] },
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
      BFF_VENDOR_URL: `http://127.0.0.1:${PORTS.bffVendor}`,
      BFF_RIDER_URL: `http://127.0.0.1:${PORTS.bffRider}`,
      SVC_DISPATCH_URL: `http://127.0.0.1:${PORTS.dispatch}`,
      SVC_TRACKING_URL: `http://127.0.0.1:${PORTS.tracking}`,
      SVC_PAYMENT_URL: `http://127.0.0.1:${PORTS.payment}`,
      SVC_MEDIA_URL: `http://127.0.0.1:${PORTS.media}`,
      ...svc.extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log: string[] = [];
  child.stdout?.on('data', (d) => log.push(String(d)));
  child.stderr?.on('data', (d) => log.push(String(d)));
  (child as any).__log = log;
  (child as any).__name = svc.name;

  // Record HOW a service died. Without this, a process that boots healthy and
  // is later OOM-killed shows up only as `fetch failed` on some unrelated
  // assertion, and the hour goes on looking for a bug in the wrong service.
  // On a 2GB box running eleven tsx processes, that is a real scenario.
  child.on('exit', (code, signal) => {
    (child as any).__exit = { code, signal, at: Date.now() };
  });
  return child;
}

/**
 * If a service has died, say so — with its exit code, its signal and the tail
 * of its own log. A SIGKILL with no message is the kernel's OOM killer.
 */
function deathReport(names?: string[]): string | null {
  const of = (p: any) => ({
    name: p.__name, exit: p.__exit, log: p.__log, pid: p.pid,
  });
  const interesting = procs.map(of)
    .filter((p) => (names ? names.includes(p.name) : true));

  const lines: string[] = [];
  for (const p of interesting) {
    if (p.exit) {
      // 137 is 128 + SIGKILL(9): the npx wrapper relaying a killed
      // grandchild. It arrives as a CODE, not a signal, which is why an
      // OOM kill is easy to misread as an ordinary non-zero exit.
      const oom = p.exit.signal === 'SIGKILL' || p.exit.code === 137;
      const how = p.exit.signal
        ? `killed by ${p.exit.signal}`
        : `exited with code ${p.exit.code}`;
      const why = oom
        ? ' — this is an OOM kill. The box has ~2GB and each tsx process '
          + 'peaks near 150MB; run fewer services, or raise the batch '
          + 'stagger in the boot loop.'
        : '';
      lines.push(`  ${p.name}: ${how}${why}`);
    } else if (names?.includes(p.name)) {
      // The npx WRAPPER is still alive but the service is unreachable, which
      // means the grandchild — the actual server — is the thing that died.
      // This is the usual shape of an OOM kill here, and it produces no exit
      // event on the process we hold, so it has to be inferred.
      lines.push(
        `  ${p.name}: wrapper pid ${p.pid} is still alive but the port is `
        + 'not answering — the server process underneath it died '
        + '(OOM kill leaves the npx wrapper running)',
      );
    } else {
      continue;
    }
    const tail = (p.log ?? []).join('').slice(-500).trim();
    if (tail) lines.push(`    last output: ${tail.replace(/\n/g, '\n    ')}`);
  }

  if (lines.length === 0) return null;
  const mem = (() => {
    try {
      const t = readFileSync('/proc/meminfo', 'utf8');
      const g = (k: string) => /(\d+)/.exec(t.split(k)[1] ?? '')?.[1];
      return `  memory: ${Math.round(Number(g('MemAvailable:')) / 1024)}MB available `
        + `of ${Math.round(Number(g('MemTotal:')) / 1024)}MB`;
    } catch { return ''; }
  })();
  return [...lines, mem].filter(Boolean).join('\n');
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
  const deaths = deathReport();
  throw new Error(
    `${name} never became healthy on :${port}\n--- log ---\n${log}`
    + (deaths ? `\n--- services that died ---\n${deaths}` : ''),
  );
}

/* ------------------------------------------------------------------ */

let admin: pg.Pool;
let storeId = '';
let itemId = '';
let vendorOwnerId = '';

before(async () => {
  admin = new pg.Pool({ connectionString: dsn('postgres') });

  // Fresh databases every run: a test that only passes on a dirty database
  // is not a test.
  for (const db of ['identity', 'catalogue', 'orders', 'payment', 'dispatch',
    'tracking']) {
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
  await migrate('payment', 'apps/svc-payment/migrations/001_ledger.sql');
  await migrate('dispatch', 'apps/svc-dispatch/migrations/001_dispatch.sql');
  await migrate('tracking', 'apps/svc-tracking/migrations/001_tracking.sql');

  // Seed one approved vendor with one dish.
  const cat = new pg.Pool({ connectionString: dsn('catalogue') });
  try {
    const alwaysOpen = JSON.stringify(Object.fromEntries(
      ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
        .map((d) => [d, { open: '00:00', close: '23:59' }]),
    ));
    const s = await cat.query<{ id: string; owner_id: string }>(
      `INSERT INTO stores (owner_id, service_type, name, latitude, longitude,
                           phone, status, operating_hours)
       VALUES (gen_random_uuid(), 'food', 'Auntie Muni Waakye',
               5.6037, -0.1870, '+233244000001', 'approved', $1::jsonb)
       RETURNING id, owner_id`, [alwaysOpen],
    );
    storeId = s.rows[0]!.id;
    vendorOwnerId = s.rows[0]!.owner_id;

    const i = await cat.query<{ id: string }>(
      `INSERT INTO items (store_id, name, base_price_pesewas, is_available)
       VALUES ($1, 'Jollof Rice', 3500, true) RETURNING id`, [storeId],
    );
    itemId = i.rows[0]!.id;
  } finally {
    await cat.end();
  }

  // Boot in small batches. Eleven concurrent tsx compilers peak around
  // 150MB each and exhaust a 2GB box; they then take so long that the
  // health timeout fires and it looks like a service is broken.
  // Batch size is a memory budget, not a speed knob. Eleven concurrent tsx
  // compilers peak near 150MB each; on a ~2GB box that ends in the OOM killer
  // taking out a service that had already reported healthy, which then
  // surfaces as an unrelated "fetch failed" two suites later. Overridable so
  // a larger machine can go faster.
  const BATCH = Number(process.env.E2E_BOOT_BATCH ?? 2);
  const wanted = SERVICES.filter(inLane);
  console.log(
    `# lane=${LANE ?? 'all'} booting ${wanted.length}/${SERVICES.length} services`,
  );
  for (let i = 0; i < wanted.length; i += BATCH) {
    const batch = wanted.slice(i, i + BATCH);
    for (const svc of batch) procs.push(launch(svc));
    for (const svc of batch) await waitForHealth(svc.port, svc.name);
    // Let each batch's compiler memory be reclaimed before adding more.
    // Without this the peaks overlap even when the steady state would fit.
    await new Promise((r) => setTimeout(r, 700));
  }
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

describe('the platform is actually wired together', { skip: laneSkip('core') }, () => {
  test('every service reports healthy', async () => {
    // Collect ALL of them before asserting. Failing on the first one hides
    // how widespread the problem is, and "media is down" reads very
    // differently from "six services are down".
    const unhealthy: string[] = [];
    for (const svc of SERVICES.filter(inLane)) {
      try {
        const res = await fetch(`http://127.0.0.1:${svc.port}/health`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (res.status !== 200) unhealthy.push(`${svc.name} (HTTP ${res.status})`);
      } catch (err) {
        unhealthy.push(`${svc.name} (${(err as Error).message})`);
      }
    }

    // A service that booted and then died is the common case on a small box,
    // and a bare "fetch failed" sends you looking for a bug that is not there.
    const deaths = deathReport(unhealthy.map((u) => u.split(' ')[0]!));
    assert.equal(
      unhealthy.length, 0,
      `unhealthy: ${unhealthy.join(', ')}`
      + (deaths ? `\n--- services that died ---\n${deaths}` : ''),
    );
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

describe('sign-in through the whole chain', { skip: laneSkip('core') }, () => {
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

describe('discovery reads the real catalogue', { skip: laneSkip('core') }, () => {
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

describe('checkout, priced by the real pricing service', { skip: laneSkip('core') }, () => {
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
    // Accra Central -> Osu is ~5.3km straight-line. With no Maps key the
    // BFF applies the 1.4 road-winding factor, so ~7.5km is correct — and
    // it errs HIGH, so an outage cannot undercharge for delivery.
    assert.ok(Number(q.distanceMetres) > 4_000 && Number(q.distanceMetres) < 9_000,
      `implausible distance: ${q.distanceMetres}`);
    assert.equal(q.distanceSource, 'estimate',
      'no GOOGLE_MAPS_SERVER_KEY in this suite, so it must say so');
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

describe('the order lifecycle reaches settlement', { skip: laneSkip('core') }, () => {
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


describe('the vendor side', { skip: laneSkip('vendor') }, () => {
  /** Sign in as a vendor whose account OWNS the seeded store. */
  async function vendorToken(phone: string) {
    // Point the seeded store at the account this login will create, so the
    // store lookup at login has something to find.
    const req = await api('/api/auth/otp/request', {
      method: 'POST', body: JSON.stringify({ phone }),
    });
    const otp = await req.json() as any;

    // Create the account first WITHOUT a store, then attach and re-login —
    // exactly the real onboarding order (sign up, register a store).
    const first = await api('/api/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ phone, code: otp.debugCode, role: 'vendor_owner' }),
    });
    const body = await first.json() as any;
    assert.equal(first.status, 201, JSON.stringify(body));

    const cat = new pg.Pool({ connectionString: dsn('catalogue') });
    try {
      await cat.query('UPDATE stores SET owner_id = $1 WHERE id = $2',
        [body.user.id, storeId]);
    } finally {
      await cat.end();
    }

    // Second login now stamps vendorId into the token.
    const req2 = await api('/api/auth/otp/request', {
      method: 'POST', body: JSON.stringify({ phone }),
    });
    const otp2 = await req2.json() as any;
    const second = await api('/api/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ phone, code: otp2.debugCode, role: 'vendor_owner' }),
    });
    const b2 = await second.json() as any;
    assert.equal(second.status, 201, JSON.stringify(b2));
    return b2.tokens.accessToken as string;
  }

  test('THE TOKEN CARRIES vendorId', async () => {
    // The bug: TokenService supported vendorId and the login never set it,
    // so every vendor-BFF route answered "No store is linked to this
    // account" and the vendor app was unusable.
    const token = await vendorToken('0244200001');
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1]!, 'base64url').toString(),
    );
    assert.equal(claims.vendorId, storeId,
      'without this the vendor app cannot load a single screen');
    assert.equal(claims.role, 'vendor_owner');
  });

  test('the vendor sees their queue', async () => {
    const token = await vendorToken('0244200002');
    const res = await api('/api/vendor/queue', { headers: auth(token) });
    const body = await res.json() as any;

    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.storeName, 'Auntie Muni Waakye');
    assert.ok(Array.isArray(body.orders));
  });

  test('a real order appears in the vendor queue', async () => {
    const vToken = await vendorToken('0244200003');

    // A customer places one.
    const c = await signIn('0244200100');
    await api('/api/users/me/addresses', {
      method: 'POST', headers: auth(c.token),
      body: JSON.stringify({ latitude: 5.5560, longitude: -0.1821, label: 'Home' }),
    });
    const placed = await (await api('/api/customer/checkout', {
      method: 'POST',
      headers: { ...auth(c.token), 'idempotency-key': 'e2e-vendor-queue' },
      body: JSON.stringify({
        storeId, lines: [{ itemId, quantity: 1 }], paymentIntent: 'prepaid',
      }),
    })).json() as any;

    // Confirm payment so it leaves pending_payment and reaches the kitchen.
    await fetch(`http://127.0.0.1:${PORTS.order}/orders/${placed.orderId}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'payment_confirmed' }),
    });

    const queue = await (await api('/api/vendor/queue', { headers: auth(vToken) }))
      .json() as any;
    const mine = queue.orders.find((o: any) => o.id === placed.orderId);

    assert.ok(mine, 'the order a customer just placed must reach the kitchen');
    // The shape VendorOrder.fromJson reads — a rename here empties the app.
    for (const k of ['id', 'humanRef', 'state', 'lines', 'itemTotalPesewas',
      'vendorAmountPesewas', 'placedAt', 'isCod']) {
      assert.ok(k in mine, `vendor order is missing "${k}"`);
    }
    assert.ok(!Number.isNaN(Date.parse(mine.placedAt)),
      'placedAt drives the accept countdown on the device');
  });

  test('the vendor can accept it, and the state really moves', async () => {
    const vToken = await vendorToken('0244200004');
    const c = await signIn('0244200101');
    await api('/api/users/me/addresses', {
      method: 'POST', headers: auth(c.token),
      body: JSON.stringify({ latitude: 5.5560, longitude: -0.1821, label: 'Home' }),
    });
    const placed = await (await api('/api/customer/checkout', {
      method: 'POST',
      headers: { ...auth(c.token), 'idempotency-key': 'e2e-vendor-accept' },
      body: JSON.stringify({
        storeId, lines: [{ itemId, quantity: 1 }], paymentIntent: 'prepaid',
      }),
    })).json() as any;
    await fetch(`http://127.0.0.1:${PORTS.order}/orders/${placed.orderId}/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'payment_confirmed' }),
    });

    const res = await api(`/api/vendor/orders/${placed.orderId}/accept`, {
      method: 'POST', headers: auth(vToken), body: JSON.stringify({}),
    });
    assert.equal(res.status, 201, JSON.stringify(await res.json()));

    const op = new pg.Pool({ connectionString: dsn('orders') });
    try {
      const r = await op.query('SELECT state FROM orders WHERE id = $1',
        [placed.orderId]);
      assert.equal(r.rows[0]!.state, 'vendor_accepted');
    } finally {
      await op.end();
    }
  });

  test('the menu includes items the vendor switched off', async () => {
    const token = await vendorToken('0244200005');
    const res = await api('/api/vendor/menu', { headers: auth(token) });
    const body = await res.json() as any;

    assert.equal(res.status, 200, JSON.stringify(body));
    assert.ok(body.items.some((i: any) => i.name === 'Jollof Rice'));
  });

  test('MARKING A DISH SOLD OUT REMOVES IT FROM THE CUSTOMER MENU', async () => {
    const vToken = await vendorToken('0244200006');

    const off = await api(`/api/vendor/menu/${itemId}/availability`, {
      method: 'PATCH', headers: auth(vToken),
      body: JSON.stringify({ isAvailable: false }),
    });
    assert.equal(off.status, 200, JSON.stringify(await off.json()));

    try {
      const c = await signIn('0244200102');
      const page = await (await api(`/api/customer/stores/${storeId}`,
        { headers: auth(c.token) })).json() as any;
      const names = page.categories[0].items.map((i: any) => i.name);
      assert.ok(!names.includes('Jollof Rice'),
        'a sold-out dish must stop being orderable immediately');
    } finally {
      // Put it back, or every later test in this file has no menu.
      await api(`/api/vendor/menu/${itemId}/availability`, {
        method: 'PATCH', headers: auth(vToken),
        body: JSON.stringify({ isAvailable: true }),
      });
    }
  });

  test('a vendor cannot act on an order from another store', async () => {
    const vToken = await vendorToken('0244200007');
    const res = await api('/api/vendor/orders/'
      + '00000000-0000-4000-8000-000000000123/accept', {
      method: 'POST', headers: auth(vToken), body: JSON.stringify({}),
    });
    assert.equal(res.status, 404,
      'probing ids must not confirm another store\'s orders exist');
  });
});


describe('the rider side', { skip: laneSkip('rider') }, () => {
  async function riderToken(phone: string) {
    const req = await api('/api/auth/otp/request', {
      method: 'POST', body: JSON.stringify({ phone }),
    });
    const otp = await req.json() as any;
    const ver = await api('/api/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ phone, code: otp.debugCode, role: 'rider' }),
    });
    const b = await ver.json() as any;
    assert.equal(ver.status, 201, JSON.stringify(b));
    return { token: b.tokens.accessToken as string, id: b.user.id as string };
  }

  test('a rider can sign in and read their state', async () => {
    const r = await riderToken('0244300001');
    const res = await api('/api/rider/state', { headers: auth(r.token) });
    const body = await res.json() as any;

    assert.equal(res.status, 200, JSON.stringify(body));
    // The exact keys RiderCoordinator.refresh() reads.
    for (const k of ['riderName', 'approved', 'walletBalancePesewas',
      'todayEarningsPesewas', 'todayDeliveries', 'codObligationPesewas',
      'activeLeg', 'offer']) {
      assert.ok(k in body, `rider state is missing "${k}"`);
    }
    assert.equal(body.activeLeg, null, 'a new rider has no job');
  });

  test('a customer token cannot read rider state', async () => {
    const c = await signIn('0244300002');
    const res = await api('/api/rider/state', { headers: auth(c.token) });
    assert.ok([401, 403].includes(res.status));
  });

  test('PROOF UPLOAD: a rider gets somewhere to put the photo', async () => {
    const r = await riderToken('0244300003');
    const res = await api('/api/rider/proof-uploads', {
      method: 'POST', headers: auth(r.token),
      body: JSON.stringify({
        orderId: '00000000-0000-4000-8000-000000000abc',
        contentType: 'image/jpeg', sizeBytes: 900_000,
      }),
    });
    const body = await res.json() as any;

    assert.equal(res.status, 201, JSON.stringify(body));
    assert.ok(body.uploadUrl,
      'without this no rider can complete a single delivery');
    assert.match(body.objectKey, /^proof_of_delivery\//);
  });

  test('an oversized proof photo is refused', async () => {
    const r = await riderToken('0244300004');
    const res = await api('/api/rider/proof-uploads', {
      method: 'POST', headers: auth(r.token),
      body: JSON.stringify({
        orderId: '00000000-0000-4000-8000-000000000abc',
        contentType: 'image/jpeg', sizeBytes: 50_000_000,
      }),
    });
    assert.equal(res.status, 422, 'the 3MB cap must hold at the edge');
  });

  test('COMPLETING A DELIVERY WITHOUT A PHOTO IS REFUSED', async () => {
    const r = await riderToken('0244300005');
    const res = await api('/api/rider/legs/leg-nonexistent/events', {
      method: 'POST', headers: auth(r.token),
      body: JSON.stringify({ event: 'rider_deliver' }),
    });
    const body = await res.json() as any;

    assert.equal(res.status, 422);
    assert.ok(body.errors?.photoUrl,
      'proof is the evidence in a "never arrived" dispute');
  });

  test('an invented rider event is refused', async () => {
    const r = await riderToken('0244300006');
    const res = await api('/api/rider/legs/leg-1/events', {
      method: 'POST', headers: auth(r.token),
      body: JSON.stringify({ event: 'mark_paid' }),
    });
    assert.equal(res.status, 422, 'the rider vocabulary is fixed');
  });

  test('a rider wallet reports a real balance', async () => {
    const r = await riderToken('0244300007');
    const res = await api('/api/rider/state', { headers: auth(r.token) });
    const body = await res.json() as any;

    assert.equal(body.walletBalancePesewas, '0');
    assert.equal(body.codObligationPesewas, '0',
      'a new rider is holding none of our cash');
  });
});

describe('degradation', { skip: laneSkip('core') }, () => {
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
