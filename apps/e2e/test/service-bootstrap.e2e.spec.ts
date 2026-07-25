/**
 * service-bootstrap.e2e.spec — the shared bootstrap over real HTTP.
 *
 * Proves that a service built on `createService()` gets health probes,
 * RFC-7807 errors, correlation IDs and graceful shutdown without writing
 * any of it, and that pricing-svc answers correctly across the wire.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  createService, portFor, requireEnv, DEFAULT_PORTS, type RunningService,
} from '../../../libs/platform/src/service/bootstrap.ts';
import { PricingHttpModule } from '../../svc-pricing/src/http.ts';

let svc: RunningService;
let BASE = '';

before(async () => {
  svc = await createService({
    name: 'svc-pricing', port: 4520, module: PricingHttpModule, host: '127.0.0.1',
  });
  BASE = svc.url;
});
after(async () => { await svc?.stop(); });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('health probes', () => {
  test('liveness does NOT touch dependencies', async () => {
    const r = await fetch(`${BASE}/health`);
    assert.equal(r.status, 200);
    const b = await r.json() as any;
    assert.equal(b.status, 'ok');
    assert.equal(b.service, 'svc-pricing');
    assert.ok(typeof b.uptimeSeconds === 'number');
  });

  test('readiness reports ready', async () => {
    const b = await (await fetch(`${BASE}/health/ready`)).json() as any;
    assert.equal(b.status, 'ready');
  });
});

describe('pricing over HTTP', () => {
  test('the canonical GHS 81.50 order comes back correctly', async () => {
    const r = await post('/pricing/quote', {
      service: 'food', itemTotalPesewas: '7000', distanceMetres: 2000,
    });
    assert.equal(r.status, 201);
    const b = await r.json() as any;
    assert.equal(b.deliveryFeePesewas, '800');
    assert.equal(b.serviceFeePesewas, '350');
    assert.equal(b.totalPesewas, '8150');
    assert.equal(b.split.vendorPesewas, '5950');
    assert.equal(b.split.riderPesewas, '800');
    assert.equal(b.split.platformPesewas, '1400');
  });

  test('money crosses the wire as strings, never as JS numbers', async () => {
    const raw = await (await post('/pricing/quote', {
      service: 'food', itemTotalPesewas: '999999999999', distanceMetres: 1000,
    })).text();
    assert.match(raw, /"totalPesewas":"\d+"/, 'a bigint must not be serialised as a number');
  });

  test('the split always reconstructs the total across the wire', async () => {
    for (const [items, dist] of [['5000', 1000], ['12345', 8000], ['1', 25000]] as const) {
      const b = await (await post('/pricing/quote', {
        service: 'food', itemTotalPesewas: items, distanceMetres: dist,
      })).json() as any;
      const sum = BigInt(b.split.vendorPesewas) + BigInt(b.split.riderPesewas)
        + BigInt(b.split.platformPesewas);
      assert.equal(sum.toString(), b.totalPesewas);
    }
  });

  test('parcel and errand quotes work', async () => {
    const parcel = await (await post('/pricing/quote/parcel', {
      weightKg: 0.5, distanceMetres: 3000,
    })).json() as any;
    assert.equal(parcel.totalPesewas, '1950');

    const errand = await (await post('/pricing/quote/errand', {
      estimatedItemCostPesewas: '10000', distanceMetres: 3000,
    })).json() as any;
    assert.equal(errand.totalPesewas, '13250');
    assert.equal(errand.autoApproveCeilingPesewas, '11500');
  });

  test('laundry charges both legs', async () => {
    const one = await (await post('/pricing/quote', {
      service: 'laundry', itemTotalPesewas: '4000', distanceMetres: 3000,
    })).json() as any;
    const two = await (await post('/pricing/quote', {
      service: 'laundry', itemTotalPesewas: '4000', distanceMetres: 3000, legs: 2,
    })).json() as any;
    assert.equal(BigInt(two.deliveryFeePesewas), BigInt(one.deliveryFeePesewas) * 2n);
  });

  test('COD eligibility is enforced server-side', async () => {
    const shop = await (await post('/pricing/cod/eligible', {
      orderTotalPesewas: '5000', service: 'shop', hourOfDay: 14,
    })).json() as any;
    assert.equal(shop.eligible, false);

    const food = await (await post('/pricing/cod/eligible', {
      orderTotalPesewas: '5000', service: 'food',
      customerCompletedOrders: 10, hourOfDay: 14,
    })).json() as any;
    assert.equal(food.eligible, true);
  });

  test('the rate card is published so apps do not hardcode fees', async () => {
    const cfg = await (await fetch(`${BASE}/pricing/config`)).json() as any;
    assert.equal(cfg.deliveryTiers.length, 4);
    assert.equal(cfg.serviceFeeBps.food, 500);
  });
});

describe('error contract from the shared bootstrap', () => {
  test('missing fields return RFC-7807 with field detail', async () => {
    const r = await post('/pricing/quote', { service: 'food' });
    assert.equal(r.status, 422);
    assert.match(r.headers.get('content-type') ?? '', /application\/problem\+json/);
    const b = await r.json() as any;
    assert.ok(b.errors.itemTotalPesewas);
    assert.ok(b.errors.distanceMetres);
  });

  test('a bad INPUT is a 422, not a 500 — the app can show the reason', async () => {
    // 500kg is over the 20kg parcel limit: the customer's mistake, not ours
    const r = await post('/pricing/quote/parcel', { weightKg: 500, distanceMetres: 1000 });
    assert.equal(r.status, 422);
    const b = await r.json() as any;
    assert.match(b.type, /pricing-invalid/);
    assert.match(b.detail, /max weight/i);
  });

  test('a negative distance is also rejected as client input', async () => {
    const r = await post('/pricing/delivery-fee', { distanceMetres: -5 });
    assert.equal(r.status, 422);
  });

  test('an unknown route 404s as a problem document', async () => {
    const r = await fetch(`${BASE}/nope`);
    assert.equal(r.status, 404);
    const b = await r.json() as any;
    assert.equal(b.status, 404);
  });

  test('correlation ids round-trip, including on errors', async () => {
    const r = await post('/pricing/quote', {}, { 'x-correlation-id': 'trace-abc' });
    assert.equal(r.headers.get('x-correlation-id'), 'trace-abc');
    const b = await r.json() as any;
    assert.equal(b.correlationId, 'trace-abc');
  });

  test('a correlation id is generated when the client omits one', async () => {
    const r = await fetch(`${BASE}/health`);
    assert.match(r.headers.get('x-correlation-id') ?? '', /^[0-9a-f-]{36}$/);
  });
});

describe('operational concerns', () => {
  test('port assignment is centralised and overridable', () => {
    assert.equal(portFor('svc-pricing', {} as any), DEFAULT_PORTS['svc-pricing']);
    assert.equal(portFor('svc-pricing', { PORT: '9999' } as any), 9999);
    assert.equal(portFor('svc-order', { SVC_ORDER_PORT: '8888' } as any), 8888);
  });

  test('every service has a distinct port', () => {
    const ports = Object.values(DEFAULT_PORTS);
    assert.equal(new Set(ports).size, ports.length, 'port collision in DEFAULT_PORTS');
  });

  test('missing environment variables fail fast at boot', () => {
    assert.throws(() => requireEnv(['DATABASE_URL', 'JWT_SECRET'], {} as any), /missing required/);
    const ok = requireEnv(['A'], { A: '1' } as any);
    assert.equal(ok.A, '1');
  });

  test('shutdown drains before closing', async () => {
    const s = await createService({
      name: 'drain-test', port: 4521, module: PricingHttpModule, host: '127.0.0.1',
    });
    // healthy first
    assert.equal((await (await fetch(`${s.url}/health/ready`)).json() as any).status, 'ready');
    await s.stop();
    // and the socket is genuinely closed afterwards
    await assert.rejects(() => fetch(`${s.url}/health`));
  });
});
