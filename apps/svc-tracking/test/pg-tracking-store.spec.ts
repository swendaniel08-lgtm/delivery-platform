/**
 * pg-tracking-store.spec — rider tracking against real Postgres + PostGIS.
 *
 * These are the cases that only a real database can answer. Three of them
 * matter more than the rest:
 *
 *   1. **Longitude/latitude order.** PostGIS is `POINT(lng lat)`; every
 *      mapping API we talk to is the reverse. Swapping them puts every Accra
 *      rider in the Atlantic Ocean, and an in-memory Map will happily agree
 *      with you either way.
 *   2. **A rejected ping must not become the baseline.** If it did, the next
 *      genuine fix would look like an implausible jump back and be rejected
 *      too — one bad GPS reading would knock a rider offline for the rest of
 *      the delivery.
 *   3. **A geofence fires exactly once, across restarts and races.** The
 *      unique index is the guard. Two pings from a reconnecting phone must
 *      not advance the order twice.
 *
 * Skips (exit 0) when no PostGIS is reachable.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

import { PgTrackingStore } from '../src/pg-tracking-store.ts';
import { processPing, type Geofence } from '../src/tracking.ts';

const ROOT = join(import.meta.dirname, '../../..');
const HOST = process.env.PGIS_TEST_HOST ?? '127.0.0.1';
const PORT = Number(process.env.PGIS_TEST_PORT ?? 55440);
const DSN = `postgresql://postgres:pw@${HOST}:${PORT}/tracking_spec`;

/**
 * Probed synchronously at TOP LEVEL — node:test evaluates `{ skip }` while
 * the describe body registers, before any hook runs. Deciding liveness in a
 * hook makes every test skip while reporting success.
 */
function probe(): boolean {
  try {
    execFileSync(process.execPath, ['-e', `
      const net = require('net');
      const s = net.connect({ host: ${JSON.stringify(HOST)}, port: ${PORT} });
      s.setTimeout(2000);
      s.on('connect', () => { s.destroy(); process.exit(0); });
      s.on('timeout', () => { s.destroy(); process.exit(1); });
      s.on('error', () => process.exit(1));
    `], { timeout: 4000, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

const live = probe();
if (!live) console.log(`# SKIP no PostGIS at ${HOST}:${PORT}`);
const skip = () => (live ? false : 'no PostGIS');

/* Accra landmarks — real coordinates, so a lat/lng swap is obvious. */
const OSU = { lat: 5.5560, lng: -0.1821 };
const ACCRA_MALL = { lat: 5.6206, lng: -0.1730 };
/** ~120 m north of OSU: outside a 100 m fence, inside a 200 m one. */
const NEAR_OSU = { lat: 5.5571, lng: -0.1821 };

const RIDER = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';
const LEG = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';

let pool: pg.Pool;
let store: PgTrackingStore;

before(async () => {
  if (!live) return;

  const admin = new pg.Pool({
    connectionString: `postgresql://postgres:pw@${HOST}:${PORT}/postgres`,
    connectionTimeoutMillis: 15_000,
  });
  await admin.query('DROP DATABASE IF EXISTS tracking_spec');
  await admin.query('CREATE DATABASE tracking_spec');
  await admin.end();

  pool = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 15_000 });
  await pool.query('CREATE EXTENSION IF NOT EXISTS postgis');
  for (const f of ['001_tracking.sql', '002_leg_projection.sql']) {
    await pool.query(readFileSync(join(ROOT, 'apps/svc-tracking/migrations', f), 'utf8'));
  }
  store = new PgTrackingStore(pool);
});

after(async () => { if (live && pool) await pool.end(); });

/** Fresh leg + participants for a test. */
async function seedLeg(over: {
  pickupRadius?: number; dropoffRadius?: number;
} = {}) {
  await pool.query('DELETE FROM geofence_events');
  await pool.query('DELETE FROM rider_pings');
  await pool.query('DELETE FROM delivery_proofs');
  await pool.query('DELETE FROM active_legs');
  await pool.query('DELETE FROM order_participants');

  await pool.query(
    `INSERT INTO active_legs
       (leg_id, order_id, rider_id, pickup_position, dropoff_position,
        pickup_radius_m, dropoff_radius_m)
     VALUES ($1,$2,$3, ST_GeogFromText($4), ST_GeogFromText($5), $6, $7)`,
    [
      LEG, ORDER, RIDER,
      `SRID=4326;POINT(${OSU.lng} ${OSU.lat})`,
      `SRID=4326;POINT(${ACCRA_MALL.lng} ${ACCRA_MALL.lat})`,
      over.pickupRadius ?? 100,
      over.dropoffRadius ?? 100,
    ],
  );
  await pool.query(
    `INSERT INTO order_participants (order_id, customer_id, rider_id, state)
     VALUES ($1,$2,$3,'in_transit')`,
    [ORDER, CUSTOMER, RIDER],
  );
}

/* ------------------------------------------------------------------ */

describe('coordinates survive the round trip', () => {
  test('a position comes back where it was put, not in the Atlantic',
    { skip: skip() }, async () => {
      await seedLeg();
      await store.saveTrack({
        riderId: RIDER,
        last: { riderId: RIDER, position: OSU, atMs: Date.now(), accuracyMetres: 8 },
        legDistanceMetres: 0,
      });

      const back = await store.lastTrack(RIDER);
      // Six decimal places is ~11cm. A lat/lng swap would put this at
      // (-0.18, 5.55) — in the Gulf of Guinea, 600km away.
      assert.ok(Math.abs(back!.last.position.lat - OSU.lat) < 1e-6,
        `latitude drifted: ${back!.last.position.lat}`);
      assert.ok(Math.abs(back!.last.position.lng - OSU.lng) < 1e-6,
        `longitude drifted: ${back!.last.position.lng}`);
      assert.equal(back!.last.accuracyMetres, 8);
    });

  test('PostGIS measures the real distance between two Accra points',
    { skip: skip() }, async () => {
      // Osu to Accra Mall is roughly 7.3km. If lat/lng were swapped this
      // would come out as a wildly different number.
      const { rows } = await pool.query<{ m: string }>(
        `SELECT ST_Distance(ST_GeogFromText($1), ST_GeogFromText($2)) AS m`,
        [
          `SRID=4326;POINT(${OSU.lng} ${OSU.lat})`,
          `SRID=4326;POINT(${ACCRA_MALL.lng} ${ACCRA_MALL.lat})`,
        ],
      );
      const km = Number(rows[0]!.m) / 1000;
      assert.ok(km > 6.5 && km < 8.5, `expected ~7.3km, got ${km.toFixed(2)}km`);
    });

  test('the running leg distance persists', { skip: skip() }, async () => {
    await seedLeg();
    await store.saveTrack({
      riderId: RIDER,
      last: { riderId: RIDER, position: OSU, atMs: Date.now() },
      legDistanceMetres: 1234.7,
    });
    assert.equal((await store.lastTrack(RIDER))!.legDistanceMetres, 1235);
  });
});

/* ------------------------------------------------------------------ */

describe('the breadcrumb trail', () => {
  test('pings accumulate rather than overwrite', { skip: skip() }, async () => {
    // The trail is the evidence in a "the rider never came" dispute. An
    // UPDATE-in-place store has no evidence at all.
    await seedLeg();
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      await store.saveTrack({
        riderId: RIDER,
        last: {
          riderId: RIDER,
          position: { lat: OSU.lat + i * 0.001, lng: OSU.lng },
          atMs: t0 + i * 5000,
        },
        legDistanceMetres: i * 110,
      });
    }
    const trail = await store.trailFor(LEG);
    assert.equal(trail.length, 5);
    // Oldest first — it is drawn as a path.
    assert.ok(trail[0]!.atMs < trail[4]!.atMs);
  });

  test('lastTrack returns the newest, not an arbitrary row',
    { skip: skip() }, async () => {
      await seedLeg();
      const t0 = Date.now();
      await store.saveTrack({
        riderId: RIDER,
        last: { riderId: RIDER, position: OSU, atMs: t0 },
        legDistanceMetres: 0,
      });
      await store.saveTrack({
        riderId: RIDER,
        last: { riderId: RIDER, position: ACCRA_MALL, atMs: t0 + 60_000 },
        legDistanceMetres: 7300,
      });
      const last = await store.lastTrack(RIDER);
      assert.ok(Math.abs(last!.last.position.lat - ACCRA_MALL.lat) < 1e-6);
    });

  test('a track survives a "restart"', { skip: skip() }, async () => {
    // A brand-new store object on the same database — this is the whole
    // point of the exercise.
    await seedLeg();
    await store.saveTrack({
      riderId: RIDER,
      last: { riderId: RIDER, position: OSU, atMs: Date.now() },
      legDistanceMetres: 500,
    });
    const afterRestart = new PgTrackingStore(pool);
    assert.equal((await afterRestart.lastTrack(RIDER))!.legDistanceMetres, 500);
  });
});

/* ------------------------------------------------------------------ */

describe('rejected pings are kept, not discarded', () => {
  test('a rejection is stored as the fraud trail', { skip: skip() }, async () => {
    await seedLeg();
    await store.recordRejection(
      RIDER,
      { riderId: RIDER, position: OSU, atMs: Date.now(), isMockLocation: true },
      'mock_location',
    );
    const counts = await store.rejectionsFor(RIDER, Date.now() - 3600_000);
    assert.deepEqual(counts, [{ reason: 'mock_location', count: 1 }]);
  });

  test('a cluster of rejections is visible as a pattern',
    { skip: skip() }, async () => {
      // One is a flaky phone. Forty is a spoofing app.
      await seedLeg();
      for (let i = 0; i < 40; i++) {
        await store.recordRejection(
          RIDER,
          { riderId: RIDER, position: OSU, atMs: Date.now() - i * 1000, isMockLocation: true },
          'mock_location',
        );
      }
      const [top] = await store.rejectionsFor(RIDER, Date.now() - 3600_000);
      assert.equal(top!.count, 40);
    });

  test('a REJECTED ping never becomes the baseline', { skip: skip() }, async () => {
    // The subtle one. If a spoofed jump were treated as the last known
    // position, the rider's next genuine fix would look like an implausible
    // jump back and be rejected too — one bad reading would take them
    // offline for the whole delivery.
    await seedLeg();
    const now = Date.now();

    await store.saveTrack({
      riderId: RIDER,
      last: { riderId: RIDER, position: OSU, atMs: now },
      legDistanceMetres: 0,
    });
    await store.recordRejection(
      RIDER,
      { riderId: RIDER, position: { lat: 9.4, lng: -0.85 }, atMs: now + 1000 },
      'implausible_jump',
    );

    const baseline = await store.lastTrack(RIDER);
    assert.ok(Math.abs(baseline!.last.position.lat - OSU.lat) < 1e-6,
      'the baseline must still be the last ACCEPTED position');

    // And the genuine next fix is therefore accepted.
    const result = processPing(
      baseline,
      { riderId: RIDER, position: NEAR_OSU, atMs: now + 6000 },
      [],
    );
    assert.equal(result.accepted, true);
  });

  test('rejections outside the window are excluded', { skip: skip() }, async () => {
    await seedLeg();
    await store.recordRejection(
      RIDER,
      { riderId: RIDER, position: OSU, atMs: Date.now() - 7 * 86_400_000 },
      'poor_accuracy',
    );
    assert.deepEqual(await store.rejectionsFor(RIDER, Date.now() - 3600_000), []);
  });
});

/* ------------------------------------------------------------------ */

describe('geofences', () => {
  test('an active leg yields both fences with their radii',
    { skip: skip() }, async () => {
      await seedLeg({ pickupRadius: 150, dropoffRadius: 250 });
      const { orderId, fences } = await store.fencesFor(RIDER);
      assert.equal(orderId, ORDER);
      assert.equal(fences.length, 2);

      const pickup = fences.find((f) => f.name === 'pickup')!;
      assert.equal(pickup.radiusMetres, 150);
      assert.equal(pickup.emitEvent, 'rider_arrive_vendor');
      assert.ok(Math.abs(pickup.centre.lat - OSU.lat) < 1e-6);

      const dropoff = fences.find((f) => f.name === 'dropoff')!;
      assert.equal(dropoff.radiusMetres, 250);
      assert.equal(dropoff.emitEvent, 'rider_arrive_customer');
    });

  test('an idle rider has no fences and no order', { skip: skip() }, async () => {
    await seedLeg();
    await pool.query('UPDATE active_legs SET completed_at = now()');
    assert.deepEqual(await store.fencesFor(RIDER), { orderId: null, fences: [] });
  });

  test('an arrival fires exactly ONCE, even across a restart',
    { skip: skip() }, async () => {
      // The rider arrives, steps away to park, and comes back. That must not
      // advance the order twice — and process memory cannot be what
      // remembers, because a redeploy would forget.
      await seedLeg();

      const first = await store.recordGeofenceEvent({
        legId: LEG, orderId: ORDER, riderId: RIDER,
        fence: 'pickup', transition: 'entered',
        lat: OSU.lat, lng: OSU.lng, distanceMetres: 12,
        emittedEvent: 'rider_arrive_vendor',
      });
      assert.equal(first, true, 'the first arrival must be recorded');

      // The fence stops advertising an event once it has fired.
      const { fences } = await store.fencesFor(RIDER);
      assert.equal(fences.find((f) => f.name === 'pickup')!.emitEvent, undefined);

      const second = await store.recordGeofenceEvent({
        legId: LEG, orderId: ORDER, riderId: RIDER,
        fence: 'pickup', transition: 'entered',
        lat: OSU.lat, lng: OSU.lng, distanceMetres: 9,
        emittedEvent: 'rider_arrive_vendor',
      });
      assert.equal(second, false, 're-entering must not fire a second event');
    });

  test('two concurrent pings cannot both fire the arrival',
    { skip: skip() }, async () => {
      // A reconnecting phone flushes its queue and two pings land at once.
      // A check-then-insert would let both through; the unique index is what
      // actually prevents it.
      await seedLeg();
      const attempt = () => store.recordGeofenceEvent({
        legId: LEG, orderId: ORDER, riderId: RIDER,
        fence: 'dropoff', transition: 'entered',
        lat: ACCRA_MALL.lat, lng: ACCRA_MALL.lng, distanceMetres: 20,
        emittedEvent: 'rider_arrive_customer',
      });
      const results = await Promise.all([attempt(), attempt(), attempt()]);
      assert.equal(results.filter(Boolean).length, 1,
        'exactly one of three concurrent arrivals may win');
    });

  test('pickup and dropoff are independent', { skip: skip() }, async () => {
    await seedLeg();
    const a = await store.recordGeofenceEvent({
      legId: LEG, orderId: ORDER, riderId: RIDER,
      fence: 'pickup', transition: 'entered',
      lat: OSU.lat, lng: OSU.lng, distanceMetres: 10,
      emittedEvent: 'rider_arrive_vendor',
    });
    const b = await store.recordGeofenceEvent({
      legId: LEG, orderId: ORDER, riderId: RIDER,
      fence: 'dropoff', transition: 'entered',
      lat: ACCRA_MALL.lat, lng: ACCRA_MALL.lng, distanceMetres: 15,
      emittedEvent: 'rider_arrive_customer',
    });
    assert.deepEqual([a, b], [true, true]);
  });

  test('an EXIT crossing is recorded every time', { skip: skip() }, async () => {
    // The uniqueness rule covers entries that emit an event. Exits are
    // informational and repeat legitimately.
    await seedLeg();
    for (let i = 0; i < 3; i++) {
      const ok = await store.recordGeofenceEvent({
        legId: LEG, orderId: ORDER, riderId: RIDER,
        fence: 'pickup', transition: 'exited',
        lat: OSU.lat, lng: OSU.lng, distanceMetres: 140,
      });
      assert.equal(ok, true);
    }
  });

  test('the real fence maths agrees with PostGIS', { skip: skip() }, async () => {
    // NEAR_OSU is ~120m out: outside a 100m fence, inside a 200m one.
    await seedLeg({ pickupRadius: 100 });
    const tight = await store.fencesFor(RIDER);
    const r1 = processPing(
      null,
      { riderId: RIDER, position: NEAR_OSU, atMs: Date.now() },
      tight.fences.filter((f) => f.name === 'pickup') as Geofence[],
    );
    assert.equal(r1.geofenceEvents.length, 0, '120m away is not an arrival');

    await seedLeg({ pickupRadius: 200 });
    const loose = await store.fencesFor(RIDER);
    const r2 = processPing(
      null,
      { riderId: RIDER, position: NEAR_OSU, atMs: Date.now() },
      loose.fences.filter((f) => f.name === 'pickup') as Geofence[],
    );
    assert.equal(r2.geofenceEvents.length, 1, 'a 200m fence should catch it');
  });
});

/* ------------------------------------------------------------------ */

describe('one active leg per rider', () => {
  test('a rider cannot hold two legs at once', { skip: skip() }, async () => {
    // The database backstop for the dispatch accept race. Redis SET NX
    // arbitrates first; this makes the data incapable of claiming a rider is
    // carrying two orders even if that ever fails open.
    await seedLeg();
    await assert.rejects(
      () => pool.query(
        `INSERT INTO active_legs (leg_id, order_id, rider_id)
         VALUES (gen_random_uuid(), gen_random_uuid(), $1)`,
        [RIDER],
      ),
      /active_legs_one_per_rider|duplicate key/,
    );
  });

  test('a completed leg frees the rider', { skip: skip() }, async () => {
    await seedLeg();
    await pool.query('UPDATE active_legs SET completed_at = now() WHERE leg_id = $1', [LEG]);
    await pool.query(
      `INSERT INTO active_legs (leg_id, order_id, rider_id)
       VALUES (gen_random_uuid(), gen_random_uuid(), $1)`,
      [RIDER],
    );
    assert.equal((await store.fencesFor(RIDER)).orderId !== null, true);
  });

  test('a nonsensical fence radius is refused', { skip: skip() }, async () => {
    // 5m would mean a rider never "arrives"; 50km would mean they arrive in
    // Tema. The CHECK constraint is cheaper than the support ticket.
    await seedLeg();
    await pool.query('UPDATE active_legs SET completed_at = now()');
    await assert.rejects(
      () => pool.query(
        `INSERT INTO active_legs (leg_id, order_id, rider_id, pickup_radius_m)
         VALUES (gen_random_uuid(), gen_random_uuid(), $1, 5)`,
        [RIDER],
      ),
      /pickup_radius_m/,
    );
  });
});

/* ------------------------------------------------------------------ */

describe('proof of delivery', () => {
  test('a proof is stored with its distance from the pin',
    { skip: skip() }, async () => {
      await seedLeg();
      await store.savePod(ORDER, {
        riderId: RIDER, lat: ACCRA_MALL.lat, lng: ACCRA_MALL.lng,
        photoUrl: 'proof_of_delivery/ord-1/a.jpg',
        recipientName: 'Ama',
        distanceMetres: 18,
      });
      const { rows } = await pool.query(
        'SELECT * FROM delivery_proofs WHERE order_id = $1', [ORDER],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.distance_from_dropoff_m, 18);
      assert.deepEqual(rows[0]!.photo_keys, ['proof_of_delivery/ord-1/a.jpg']);
    });

  test('a far-away proof is findable — the dispute signal',
    { skip: skip() }, async () => {
      // "Delivered" from 800m away deserves a look. A partial index exists
      // for exactly this query.
      await seedLeg();
      await store.savePod(ORDER, {
        riderId: RIDER, lat: OSU.lat, lng: OSU.lng, distanceMetres: 800,
      });
      const { rows } = await pool.query(
        'SELECT order_id FROM delivery_proofs WHERE distance_from_dropoff_m > 300',
      );
      assert.equal(rows.length, 1);
    });

  test('re-submitting a proof updates rather than failing',
    { skip: skip() }, async () => {
      // A rider on a flaky network retries. That must not 500.
      await seedLeg();
      const pod = {
        riderId: RIDER, lat: ACCRA_MALL.lat, lng: ACCRA_MALL.lng, distanceMetres: 20,
      };
      await store.savePod(ORDER, pod);
      await store.savePod(ORDER, { ...pod, recipientName: 'Kofi', distanceMetres: 22 });

      const { rows } = await pool.query(
        'SELECT recipient_name, distance_from_dropoff_m FROM delivery_proofs WHERE order_id = $1',
        [ORDER],
      );
      assert.equal(rows.length, 1, 'one proof per leg');
      assert.equal(rows[0]!.recipient_name, 'Kofi');
    });
});

/* ------------------------------------------------------------------ */

describe('watch authorisation', () => {
  test('participants come back for a real order', { skip: skip() }, async () => {
    await seedLeg();
    const p = await store.participants(ORDER);
    assert.equal(p!.customerId, CUSTOMER);
    assert.equal(p!.riderId, RIDER);
  });

  test('an unknown order yields null, not an empty shell',
    { skip: skip() }, async () => {
      // A caller must not be able to mistake "no such order" for "an order
      // with no participants", which would authorise everybody.
      assert.equal(
        await store.participants('99999999-9999-4999-8999-999999999999'),
        null,
      );
    });
});
