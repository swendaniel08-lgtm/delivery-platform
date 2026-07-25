/**
 * tracking-http.spec — ping ingestion, position reads and POD over HTTP.
 *
 * The authorisation tests matter as much as the geometry: a live rider
 * position is a person's real-time location, and leaking it to anyone who
 * can guess an order id would be a genuine safety problem.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createService, type RunningService } from '../../../libs/platform/src/service/bootstrap.ts';
import {
  TrackingHttpModule, InMemoryTrackingStore, type Claims,
} from '../src/http.ts';
import { TrackingHub, GEOFENCE_RADIUS_METRES } from '../src/tracking.ts';

let svc: RunningService;
let BASE = '';
let store: InMemoryTrackingStore;
let hub: TrackingHub;

const VENDOR = { lat: 5.6037, lng: -0.1870 };   // Accra Central
const HOME = { lat: 5.5560, lng: -0.1821 };     // Osu

const token = (sub: string, role: string) => `${sub}:${role}`;
const verifyToken = (t: string): Claims => {
  const [sub, role] = t.split(':');
  if (!sub || !role) throw new Error('bad token');
  return { sub, role };
};
const as = (sub: string, role: string) => ({
  authorization: `Bearer ${token(sub, role)}`, 'content-type': 'application/json',
});

before(async () => {
  store = new InMemoryTrackingStore();
  hub = new TrackingHub();
  svc = await createService({
    name: 'svc-tracking', port: 4534, host: '127.0.0.1',
    module: TrackingHttpModule.forRoot({ store, hub, verifyToken }),
  });
  BASE = svc.url;
});
after(async () => { await svc?.stop(); });

beforeEach(() => {
  store.tracks.clear();
  store.rejections.length = 0;
  store.legs.clear();
  store.orders.clear();
  store.pods.length = 0;
});

const post = (p: string, b: unknown, h: Record<string, string> = {}) =>
  fetch(`${BASE}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b),
  });
const get = (p: string, h: Record<string, string> = {}) => fetch(`${BASE}${p}`, { headers: h });

/** Put a rider on an active delivery with both fences. */
function onDelivery(riderId: string, orderId: string) {
  store.legs.set(riderId, {
    orderId,
    fences: [
      { name: 'pickup', centre: VENDOR, radiusMetres: GEOFENCE_RADIUS_METRES,
        emitEvent: 'rider_at_vendor' },
      { name: 'dropoff', centre: HOME, radiusMetres: GEOFENCE_RADIUS_METRES,
        emitEvent: 'arrived' },
    ],
  });
  store.orders.set(orderId, {
    customerId: 'cust-1', vendorOwnerId: 'vend-1', riderId, terminal: false,
  });
}

/* ------------------------------------------------------------------ */

describe('ping ingestion', () => {
  test('a clean ping is accepted and tells the app when to ping again', async () => {
    onDelivery('r1', 'o1');
    const r = await post('/tracking/pings',
      { lat: 5.5900, lng: -0.1850, atMs: Date.now() }, as('r1', 'rider'));
    const b = await r.json() as any;

    assert.equal(r.status, 201);
    assert.equal(b.accepted, true);
    assert.equal(b.nextPingSeconds, 5, 'on an active delivery, every 5s');
  });

  test('an idle rider is told to ping far less often', async () => {
    const b = await (await post('/tracking/pings',
      { lat: 5.5900, lng: -0.1850, atMs: Date.now() }, as('r-idle', 'rider'))).json() as any;
    assert.equal(b.nextPingSeconds, 30, 'idle riders must not burn battery at 5s');
  });

  test('a mock-location ping is rejected AND recorded as evidence', async () => {
    const r = await post('/tracking/pings',
      { lat: 5.5900, lng: -0.1850, atMs: Date.now(), isMockLocation: true },
      as('r-fraud', 'rider'));
    const b = await r.json() as any;

    assert.equal(r.status, 201, 'a bad fix is not a client error to retry');
    assert.equal(b.accepted, false);
    assert.equal(b.rejection, 'mock_location');
    assert.equal(store.rejections.length, 1, 'the fraud trail is kept, not discarded');
    assert.equal(store.rejections[0]!.riderId, 'r-fraud');
  });

  test('a ping from outside Ghana is rejected', async () => {
    const b = await (await post('/tracking/pings',
      { lat: 51.5074, lng: -0.1278, atMs: Date.now() }, as('r2', 'rider'))).json() as any;
    assert.equal(b.accepted, false);
    assert.equal(b.rejection, 'out_of_bounds');
  });

  test('a wildly inaccurate fix is rejected before it can trip a geofence', async () => {
    const b = await (await post('/tracking/pings',
      { lat: 5.5900, lng: -0.1850, atMs: Date.now(), accuracyMetres: 900 },
      as('r3', 'rider'))).json() as any;
    assert.equal(b.accepted, false);
    assert.equal(b.rejection, 'poor_accuracy');
  });

  test('an out-of-order ping is dropped', async () => {
    const t = Date.now();
    await post('/tracking/pings', { lat: 5.59, lng: -0.185, atMs: t }, as('r4', 'rider'));
    const b = await (await post('/tracking/pings',
      { lat: 5.59, lng: -0.185, atMs: t - 10_000 }, as('r4', 'rider'))).json() as any;
    assert.equal(b.accepted, false);
    assert.equal(b.rejection, 'stale');
  });

  test('a teleport across Accra in one second is rejected', async () => {
    const t = Date.now();
    await post('/tracking/pings', { lat: 5.6037, lng: -0.1870, atMs: t }, as('r5', 'rider'));
    const b = await (await post('/tracking/pings',
      { lat: 5.5560, lng: -0.1821, atMs: t + 1000 }, as('r5', 'rider'))).json() as any;
    assert.equal(b.accepted, false);
    assert.equal(b.rejection, 'implausible_jump');
  });

  test('arriving at the vendor raises a geofence event', async () => {
    onDelivery('r6', 'o6');
    const t = Date.now();
    // Start well away, then arrive at the vendor.
    await post('/tracking/pings', { lat: 5.5800, lng: -0.1850, atMs: t }, as('r6', 'rider'));
    const b = await (await post('/tracking/pings',
      { lat: VENDOR.lat, lng: VENDOR.lng, atMs: t + 600_000 }, as('r6', 'rider'))).json() as any;

    assert.equal(b.accepted, true);
    const entered = b.geofenceEvents.find((e: any) => e.fence === 'pickup');
    assert.ok(entered, 'the pickup fence fired');
    assert.equal(entered.transition, 'entered');
    assert.equal(entered.emitEvent, 'rider_at_vendor',
      'the event that advances the order state machine');
  });

  test('distance accumulates across pings', async () => {
    onDelivery('r7', 'o7');
    const t = Date.now();
    await post('/tracking/pings', { lat: 5.6037, lng: -0.1870, atMs: t }, as('r7', 'rider'));
    await post('/tracking/pings',
      { lat: 5.6000, lng: -0.1860, atMs: t + 120_000 }, as('r7', 'rider'));

    const track = store.tracks.get('r7')!;
    assert.ok(track.legDistanceMetres > 300, 'the leg odometer is running');
  });

  test('missing coordinates are 422', async () => {
    const r = await post('/tracking/pings', { atMs: Date.now() }, as('r8', 'rider'));
    assert.equal(r.status, 422);
  });

  test('only riders may push pings', async () => {
    assert.equal((await post('/tracking/pings',
      { lat: 5.6, lng: -0.18, atMs: Date.now() })).status, 401);
    assert.equal((await post('/tracking/pings',
      { lat: 5.6, lng: -0.18, atMs: Date.now() }, as('c1', 'customer'))).status, 403);
  });
});

describe('reading a position', () => {
  test('the customer on the order can see their rider', async () => {
    onDelivery('r9', 'o9');
    await post('/tracking/pings',
      { lat: 5.5900, lng: -0.1850, atMs: Date.now() }, as('r9', 'rider'));

    const b = await (await get('/tracking/orders/o9/position', as('cust-1', 'customer')))
      .json() as any;
    assert.equal(b.riderAssigned, true);
    assert.ok(Math.abs(b.position.lat - 5.5900) < 1e-6);
    assert.ok(b.ageSeconds >= 0 && b.ageSeconds < 5,
      'the app greys out a stale dot, so it needs the age');
  });

  test('a stranger cannot locate someone else\'s rider', async () => {
    onDelivery('r10', 'o10');
    const r = await get('/tracking/orders/o10/position', as('nosy', 'customer'));
    assert.equal(r.status, 404,
      'a live location leak is a safety problem, so we do not even confirm the order');
  });

  test('an admin can watch any order', async () => {
    onDelivery('r11', 'o11');
    await post('/tracking/pings',
      { lat: 5.5900, lng: -0.1850, atMs: Date.now() }, as('r11', 'rider'));
    const r = await get('/tracking/orders/o11/position', as('admin-1', 'admin'));
    assert.equal(r.status, 200);
  });

  test('a finished order stops reporting a position', async () => {
    onDelivery('r12', 'o12');
    store.orders.set('o12', {
      customerId: 'cust-1', vendorOwnerId: 'vend-1', riderId: 'r12', terminal: true,
    });
    const r = await get('/tracking/orders/o12/position', as('cust-1', 'customer'));
    assert.equal(r.status, 404, 'tracking must not outlive the delivery');
  });

  test('an order with no rider yet answers cleanly rather than erroring', async () => {
    store.orders.set('o13', {
      customerId: 'cust-1', vendorOwnerId: 'vend-1', riderId: null, terminal: false,
    });
    const b = await (await get('/tracking/orders/o13/position', as('cust-1', 'customer')))
      .json() as any;
    assert.equal(b.riderAssigned, false);
    assert.equal(b.position, null);
  });

  test('an unknown order is 404', async () => {
    assert.equal((await get('/tracking/orders/nope/position', as('c', 'customer'))).status, 404);
  });

  test('reading a position needs a token', async () => {
    assert.equal((await get('/tracking/orders/o9/position')).status, 401);
  });
});

describe('proof of delivery', () => {
  test('a POD at the door is recorded and passes the geofence', async () => {
    onDelivery('r14', 'o14');
    const b = await (await post('/tracking/orders/o14/pod',
      { lat: HOME.lat, lng: HOME.lng, recipientName: 'Ama' }, as('r14', 'rider'))).json() as any;

    assert.equal(b.recorded, true);
    assert.equal(b.withinGeofence, true);
    assert.ok(b.distanceMetres < GEOFENCE_RADIUS_METRES);
    assert.equal(b.flagged, undefined);
    assert.equal(store.pods.length, 1);
  });

  test('a POD filed far from the dropoff is accepted but flagged', async () => {
    onDelivery('r15', 'o15');
    // 800m short of the door.
    const b = await (await post('/tracking/orders/o15/pod',
      { lat: 5.5630, lng: -0.1821 }, as('r15', 'rider'))).json() as any;

    assert.equal(b.recorded, true, 'the customer may have walked out to the road');
    assert.equal(b.withinGeofence, false);
    assert.equal(b.flagged, 'pod_outside_geofence',
      'flagged for review — this is the evidence in a "never arrived" dispute');
    assert.ok(b.distanceMetres > 500);
  });

  test('another rider cannot file a POD for a delivery that is not theirs', async () => {
    onDelivery('r16', 'o16');
    const r = await post('/tracking/orders/o16/pod',
      { lat: HOME.lat, lng: HOME.lng }, as('r-other', 'rider'));
    assert.equal(r.status, 403);
  });

  test('a customer cannot file their own POD', async () => {
    onDelivery('r17', 'o17');
    const r = await post('/tracking/orders/o17/pod',
      { lat: HOME.lat, lng: HOME.lng }, as('cust-1', 'customer'));
    assert.equal(r.status, 403);
  });

  test('a POD without coordinates is refused', async () => {
    onDelivery('r18', 'o18');
    const r = await post('/tracking/orders/o18/pod', { recipientName: 'Ama' }, as('r18', 'rider'));
    assert.equal(r.status, 422);
  });
});

describe('config', () => {
  test('publishes the ping cadence the rider app follows', async () => {
    const b = await (await get('/tracking/config')).json() as any;
    assert.equal(b.activePingSeconds, 5);
    assert.equal(b.idlePingSeconds, 30);
    assert.equal(b.geofenceRadiusMetres, 100);
  });
});
