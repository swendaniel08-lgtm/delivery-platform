/** tracking.spec — GPS validation, geofencing, fanout and authorisation. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  processPing, TrackingHub, canWatchOrder, pingIntervalSeconds, assertValidPing,
  GEOFENCE_RADIUS_METRES, PING_INTERVAL_ACTIVE_SECONDS,
  type RiderTrack, type Geofence, type Subscriber, type OrderParticipants,
} from '../src/tracking.ts';
import { ValidationError } from '../../../libs/platform/src/errors.ts';

const VENDOR = { lat: 5.5560, lng: -0.1821 };
const CUSTOMER = { lat: 5.5800, lng: -0.1750 };
const T0 = 1_700_000_000_000;

const track = (p: { lat: number; lng: number }, atMs = T0): RiderTrack => ({
  riderId: 'r1', last: { riderId: 'r1', position: p, atMs }, legDistanceMetres: 0,
});

const fences: Geofence[] = [
  { name: 'pickup', centre: VENDOR, radiusMetres: GEOFENCE_RADIUS_METRES, emitEvent: 'rider_arrive_vendor' },
  { name: 'dropoff', centre: CUSTOMER, radiusMetres: GEOFENCE_RADIUS_METRES, emitEvent: 'rider_arrive' },
];

describe('ping validation', () => {
  test('accepts a normal ping', () => {
    const r = processPing(track(VENDOR), {
      riderId: 'r1', position: { lat: 5.5570, lng: -0.1815 }, atMs: T0 + 5_000,
    });
    assert.equal(r.accepted, true);
    assert.ok(r.movedMetres > 0);
  });

  test('rejects a mock location — this could fake a delivery', () => {
    const r = processPing(track(VENDOR), {
      riderId: 'r1', position: CUSTOMER, atMs: T0 + 5_000, isMockLocation: true,
    });
    assert.equal(r.accepted, false);
    assert.equal(r.rejection, 'mock_location');
    assert.deepEqual(r.geofenceEvents, [], 'a spoof must never trigger a geofence');
  });

  test('rejects an implausible jump (teleport to the dropoff)', () => {
    const r = processPing(track(VENDOR), {
      riderId: 'r1', position: CUSTOMER, atMs: T0 + 1_000,  // 2.8 km in 1 s
    }, fences);
    assert.equal(r.accepted, false);
    assert.equal(r.rejection, 'implausible_jump');
    assert.deepEqual(r.geofenceEvents, []);
  });

  test('a plausible jump over a longer interval is accepted', () => {
    const r = processPing(track(VENDOR), {
      riderId: 'r1', position: CUSTOMER, atMs: T0 + 600_000,  // 2.8 km in 10 min
    });
    assert.equal(r.accepted, true);
  });

  test('rejects out-of-order pings', () => {
    const r = processPing(track(VENDOR, T0 + 10_000), {
      riderId: 'r1', position: VENDOR, atMs: T0 + 5_000,
    });
    assert.equal(r.rejection, 'stale');
  });

  test('rejects very inaccurate fixes', () => {
    const r = processPing(track(VENDOR), {
      riderId: 'r1', position: CUSTOMER, atMs: T0 + 600_000, accuracyMetres: 500,
    });
    assert.equal(r.rejection, 'poor_accuracy');
  });

  test('rejects positions outside Ghana', () => {
    const r = processPing(null, { riderId: 'r1', position: { lat: 51.5, lng: -0.12 }, atMs: T0 });
    assert.equal(r.rejection, 'out_of_bounds');
  });

  test('GPS jitter while stationary is tolerated', () => {
    const r = processPing(track(VENDOR), {
      riderId: 'r1', position: { lat: VENDOR.lat + 0.0002, lng: VENDOR.lng }, atMs: T0 + 1_000,
    });
    assert.equal(r.accepted, true, 'small wobble must not look like a jump');
  });

  test('validates the payload shape', () => {
    assert.throws(() => assertValidPing({ riderId: 'r', position: { lat: NaN, lng: 0 }, atMs: T0 }), ValidationError);
    assert.throws(() => assertValidPing({ riderId: 'r', position: VENDOR, atMs: 0 }), ValidationError);
  });
});

describe('geofencing', () => {
  test('entering the vendor fence emits the arrival event', () => {
    const away = { lat: 5.5600, lng: -0.1860 };   // ~600 m out
    const r = processPing(track(away), {
      riderId: 'r1', position: { lat: 5.5561, lng: -0.1822 }, atMs: T0 + 120_000,
    }, fences);
    assert.equal(r.accepted, true);
    const entered = r.geofenceEvents.find((e) => e.fence === 'pickup');
    assert.equal(entered?.transition, 'entered');
    assert.equal(entered?.emitEvent, 'rider_arrive_vendor');
  });

  test('an event fires once on entry, not on every ping inside', () => {
    const inside1 = { lat: 5.5561, lng: -0.1822 };
    const inside2 = { lat: 5.5562, lng: -0.1823 };
    const r = processPing(track(inside1), { riderId: 'r1', position: inside2, atMs: T0 + 5_000 }, fences);
    assert.equal(r.geofenceEvents.length, 0, 'already inside — no repeat event');
  });

  test('leaving a fence emits an exit', () => {
    const inside = { lat: 5.5561, lng: -0.1822 };
    const outside = { lat: 5.5620, lng: -0.1880 };
    const r = processPing(track(inside), { riderId: 'r1', position: outside, atMs: T0 + 120_000 }, fences);
    assert.equal(r.geofenceEvents[0]?.transition, 'exited');
  });

  test('arriving at the customer emits the dropoff event', () => {
    const near = { lat: 5.5795, lng: -0.1752 };
    const away = { lat: 5.5700, lng: -0.1800 };
    const r = processPing(track(away), { riderId: 'r1', position: near, atMs: T0 + 300_000 }, fences);
    const evt = r.geofenceEvents.find((e) => e.fence === 'dropoff');
    assert.equal(evt?.emitEvent, 'rider_arrive');
  });
});

describe('fanout', () => {
  function sub(id: string): Subscriber & { received: unknown[] } {
    const received: unknown[] = [];
    return { principalId: id, role: 'customer', received, send: (p) => received.push(p) };
  }

  test('only subscribers to that order receive positions', () => {
    const hub = new TrackingHub();
    const a = sub('cust-a'); const b = sub('cust-b');
    hub.subscribe('order-1', a);
    hub.subscribe('order-2', b);

    hub.broadcast('order-1', { position: VENDOR, etaSeconds: 300, state: 'in_transit' }, T0);
    assert.equal(a.received.length, 1);
    assert.equal(b.received.length, 0, 'must not leak another order\'s rider position');
  });

  test('broadcasts are throttled to 3 s', () => {
    const hub = new TrackingHub();
    const a = sub('cust-a');
    hub.subscribe('order-1', a);

    hub.broadcast('order-1', { position: VENDOR, etaSeconds: 300, state: 'in_transit' }, T0);
    hub.broadcast('order-1', { position: VENDOR, etaSeconds: 299, state: 'in_transit' }, T0 + 1_000);
    hub.broadcast('order-1', { position: VENDOR, etaSeconds: 298, state: 'in_transit' }, T0 + 2_000);
    assert.equal(a.received.length, 1, '5 s pings must not become 5 s broadcasts');

    hub.broadcast('order-1', { position: VENDOR, etaSeconds: 290, state: 'in_transit' }, T0 + 3_500);
    assert.equal(a.received.length, 2);
  });

  test('unsubscribing stops delivery', () => {
    const hub = new TrackingHub();
    const a = sub('cust-a');
    const off = hub.subscribe('order-1', a);
    off();
    assert.equal(hub.broadcast('order-1', { position: VENDOR, etaSeconds: 1, state: 'x' }, T0), false);
    assert.equal(a.received.length, 0);
  });

  test('closing the room stops all further positions', () => {
    const hub = new TrackingHub();
    const a = sub('cust-a'); const b = sub('cust-b');
    hub.subscribe('order-1', a); hub.subscribe('order-1', b);
    assert.equal(hub.closeRoom('order-1'), 2);
    assert.equal(hub.subscriberCount('order-1'), 0);
    assert.equal(hub.broadcast('order-1', { position: VENDOR, etaSeconds: 1, state: 'x' }, T0), false);
  });

  test('broadcasting to an empty room is a no-op, not an error', () => {
    const hub = new TrackingHub();
    assert.equal(hub.broadcast('nobody', { position: VENDOR, etaSeconds: 1, state: 'x' }), false);
  });
});

describe('authorisation — who may watch a rider', () => {
  const order: OrderParticipants = {
    customerId: 'cust-1', vendorOwnerId: 'vend-1', riderId: 'rider-1', terminal: false,
  };

  test('the customer on the order may watch', () => {
    assert.equal(canWatchOrder('cust-1', 'customer', order).allowed, true);
  });

  test('a different customer may NOT watch', () => {
    const d = canWatchOrder('cust-2', 'customer', order);
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /not your order/);
  });

  test('the vendor on the order may watch', () => {
    assert.equal(canWatchOrder('vend-1', 'vendor', order).allowed, true);
    assert.equal(canWatchOrder('vend-2', 'vendor', order).allowed, false);
  });

  test('admins may watch anything — live ops map', () => {
    assert.equal(canWatchOrder('admin-1', 'admin', order).allowed, true);
  });

  test('nobody keeps watching a finished order', () => {
    const done = { ...order, terminal: true };
    assert.equal(canWatchOrder('cust-1', 'customer', done).allowed, false);
  });
});

describe('ping cadence (PDF §9)', () => {
  test('5 s on an active delivery, 30 s when idle', () => {
    assert.equal(pingIntervalSeconds(true), 5);
    assert.equal(pingIntervalSeconds(false), 30);
    assert.equal(PING_INTERVAL_ACTIVE_SECONDS, 5);
  });
});
