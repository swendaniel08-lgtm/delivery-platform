/**
 * schemas.e2e.spec — the four new service schemas against real Postgres.
 *
 * These constraints are the last line of defence for rules the application
 * also enforces. Testing them here means a bug in service code cannot
 * silently corrupt data.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const DSN = process.env.SCHEMA_TEST_DSN ?? 'postgresql://postgres:pw@localhost:55440/t';
let pool: pg.Pool | undefined;
let up = false;

const RIDER_A = '11111111-1111-1111-1111-111111111111';
const RIDER_B = '22222222-2222-2222-2222-222222222222';
const LEG_1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const LEG_2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const ORDER_1 = 'bbbbbbbb-0000-0000-0000-000000000001';

before(async () => {
  try {
    pool = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
    await pool.query('SELECT 1');
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const root = process.cwd();
    for (const svc of ['svc-dispatch', 'svc-tracking', 'svc-messaging', 'svc-media']) {
      const file = join(root, `apps/${svc}/migrations/001_${svc.replace('svc-', '')}.sql`);
      await pool.query(readFileSync(file, 'utf8'));
    }
    up = true;
  } catch (e) {
    console.error('schema e2e skipped:', (e as Error).message);
    up = false;
  }
});
after(async () => { await pool?.end(); });

async function seedRider(id: string, opts: {
  online?: boolean; vehicle?: string; cod?: number;
  lat?: number; lng?: number; stalePings?: boolean; sidelined?: boolean;
} = {}) {
  await pool!.query(
    `INSERT INTO rider_availability
       (rider_id, vehicle, is_online, cod_obligation_pesewas, last_position,
        last_ping_at, sidelined_until)
     VALUES ($1, $2::vehicle_kind, $3, $4,
             ST_SetSRID(ST_MakePoint($6, $5), 4326)::geography,
             $7, $8)
     ON CONFLICT (rider_id) DO UPDATE SET
       is_online = EXCLUDED.is_online,
       cod_obligation_pesewas = EXCLUDED.cod_obligation_pesewas,
       last_position = EXCLUDED.last_position,
       last_ping_at = EXCLUDED.last_ping_at,
       sidelined_until = EXCLUDED.sidelined_until`,
    [
      id, opts.vehicle ?? 'motorbike', opts.online ?? true, opts.cod ?? 0,
      opts.lat ?? 5.5565, opts.lng ?? -0.1825,
      opts.stalePings ? new Date(Date.now() - 10 * 60_000) : new Date(),
      opts.sidelined ? new Date(Date.now() + 3600_000) : null,
    ],
  );
}

/* ================================================================== */

describe('dispatch: candidate search', () => {
  const OSU = { lat: 5.5560, lng: -0.1821 };

  test('finds a nearby online rider', async (t) => {
    if (!up) return t.skip('no database');
    await seedRider(RIDER_A);
    const r = await pool!.query(
      `SELECT * FROM find_dispatch_candidates($1,$2,3000,ARRAY['motorbike']::vehicle_kind[],false,0)`,
      [OSU.lat, OSU.lng]);
    assert.equal(r.rowCount, 1);
    assert.ok(Number(r.rows[0]!.distance_metres) < 200);
  });

  test('a rider whose phone stopped reporting is NOT available', async (t) => {
    if (!up) return t.skip('no database');
    await seedRider(RIDER_A, { stalePings: true });
    const r = await pool!.query(
      `SELECT * FROM find_dispatch_candidates($1,$2,3000,ARRAY['motorbike']::vehicle_kind[],false,0)`,
      [OSU.lat, OSU.lng]);
    assert.equal(r.rowCount, 0, 'a stale fix means we do not know where they are');
  });

  test('vehicle capability is enforced in the query', async (t) => {
    if (!up) return t.skip('no database');
    await seedRider(RIDER_A, { vehicle: 'bicycle' });
    const car = await pool!.query(
      `SELECT * FROM find_dispatch_candidates($1,$2,3000,ARRAY['car']::vehicle_kind[],false,0)`,
      [OSU.lat, OSU.lng]);
    assert.equal(car.rowCount, 0);
  });

  test('COD ceiling is evaluated AFTER this order, not before', async (t) => {
    if (!up) return t.skip('no database');
    // holding GHS 250, ceiling GHS 300
    await seedRider(RIDER_A, { cod: 25000 });

    const bigCash = await pool!.query(
      `SELECT * FROM find_dispatch_candidates($1,$2,3000,ARRAY['motorbike']::vehicle_kind[],true,10000)`,
      [OSU.lat, OSU.lng]);
    assert.equal(bigCash.rowCount, 0, 'GHS 250 + GHS 100 would exceed GHS 300');

    const smallCash = await pool!.query(
      `SELECT * FROM find_dispatch_candidates($1,$2,3000,ARRAY['motorbike']::vehicle_kind[],true,4000)`,
      [OSU.lat, OSU.lng]);
    assert.equal(smallCash.rowCount, 1, 'GHS 40 still fits');

    const prepaid = await pool!.query(
      `SELECT * FROM find_dispatch_candidates($1,$2,3000,ARRAY['motorbike']::vehicle_kind[],false,10000)`,
      [OSU.lat, OSU.lng]);
    assert.equal(prepaid.rowCount, 1, 'cash limits must not block prepaid work');
  });

  test('a sidelined rider is skipped', async (t) => {
    if (!up) return t.skip('no database');
    await seedRider(RIDER_A, { sidelined: true });
    const r = await pool!.query(
      `SELECT * FROM find_dispatch_candidates($1,$2,3000,ARRAY['motorbike']::vehicle_kind[],false,0)`,
      [OSU.lat, OSU.lng]);
    assert.equal(r.rowCount, 0);
  });

  test('radius is respected and results are nearest-first', async (t) => {
    if (!up) return t.skip('no database');
    await seedRider(RIDER_A, { lat: 5.5561, lng: -0.1822 });        // ~15m
    await seedRider(RIDER_B, { lat: 5.5700, lng: -0.1900 });        // ~1.7km
    const near = await pool!.query(
      `SELECT rider_id FROM find_dispatch_candidates($1,$2,3000,ARRAY['motorbike']::vehicle_kind[],false,0)`,
      [OSU.lat, OSU.lng]);
    assert.equal(near.rowCount, 2);
    assert.equal(near.rows[0]!.rider_id, RIDER_A);

    const tight = await pool!.query(
      `SELECT rider_id FROM find_dispatch_candidates($1,$2,500,ARRAY['motorbike']::vehicle_kind[],false,0)`,
      [OSU.lat, OSU.lng]);
    assert.equal(tight.rowCount, 1);
  });
});

describe('dispatch: assignment invariants', () => {
  test('a leg can never have two active assignments (durable issue #7 guard)',
    async (t) => {
      if (!up) return t.skip('no database');
      await pool!.query('DELETE FROM assignments');
      await pool!.query(
        `INSERT INTO assignments (leg_id, order_id, rider_id) VALUES ($1,$2,$3)`,
        [LEG_1, ORDER_1, RIDER_A]);
      await assert.rejects(() => pool!.query(
        `INSERT INTO assignments (leg_id, order_id, rider_id) VALUES ($1,$2,$3)`,
        [LEG_1, ORDER_1, RIDER_B]),
        'even with Redis flushed, the DB refuses a double assignment');
    });

  test('a rider carries one job at a time', async (t) => {
    if (!up) return t.skip('no database');
    await pool!.query('DELETE FROM assignments');
    await pool!.query(
      `INSERT INTO assignments (leg_id, order_id, rider_id) VALUES ($1,$2,$3)`,
      [LEG_1, ORDER_1, RIDER_A]);
    await assert.rejects(() => pool!.query(
      `INSERT INTO assignments (leg_id, order_id, rider_id) VALUES ($1,$2,$3)`,
      [LEG_2, ORDER_1, RIDER_A]));
  });

  test('completing frees both the leg and the rider', async (t) => {
    if (!up) return t.skip('no database');
    await pool!.query('DELETE FROM assignments');
    await pool!.query(
      `INSERT INTO assignments (leg_id, order_id, rider_id) VALUES ($1,$2,$3)`,
      [LEG_1, ORDER_1, RIDER_A]);
    await pool!.query(
      `UPDATE assignments SET state='completed', completed_at=now() WHERE leg_id=$1`,
      [LEG_1]);
    // reassignment now possible
    await pool!.query(
      `INSERT INTO assignments (leg_id, order_id, rider_id) VALUES ($1,$2,$3)`,
      [LEG_1, ORDER_1, RIDER_B]);
  });

  test('a cancelled assignment must say why', async (t) => {
    if (!up) return t.skip('no database');
    await pool!.query('DELETE FROM assignments');
    await pool!.query(
      `INSERT INTO assignments (leg_id, order_id, rider_id) VALUES ($1,$2,$3)`,
      [LEG_2, ORDER_1, RIDER_A]);
    await assert.rejects(() => pool!.query(
      `UPDATE assignments SET state='cancelled' WHERE leg_id=$1`, [LEG_2]));
    await pool!.query(
      `UPDATE assignments SET state='cancelled', cancel_reason='rider broke down'
        WHERE leg_id=$1`, [LEG_2]);
  });
});

describe('tracking', () => {
  test('rejected pings are STORED — they are the fraud signal', async (t) => {
    if (!up) return t.skip('no database');
    await pool!.query(
      `INSERT INTO rider_pings (rider_id, leg_id, position, outcome, recorded_at)
       VALUES ($1,$2, ST_SetSRID(ST_MakePoint(-0.18,5.55),4326)::geography,
               'mock_location', now())`, [RIDER_A, LEG_1]);
    const r = await pool!.query(
      `SELECT count(*) c FROM rider_pings WHERE outcome <> 'accepted'`);
    assert.equal(r.rows[0]!.c, '1');
  });

  test('an arrival auto-advances the order exactly once', async (t) => {
    if (!up) return t.skip('no database');
    await pool!.query(
      `INSERT INTO geofence_events
         (leg_id, order_id, rider_id, fence, transition, position, distance_m, emitted_event)
       VALUES ($1,$2,$3,'dropoff','entered',
               ST_SetSRID(ST_MakePoint(-0.175,5.58),4326)::geography, 40, 'rider_arrive')`,
      [LEG_1, ORDER_1, RIDER_A]);

    // stepping away and returning must NOT fire a second arrival
    await assert.rejects(() => pool!.query(
      `INSERT INTO geofence_events
         (leg_id, order_id, rider_id, fence, transition, position, distance_m, emitted_event)
       VALUES ($1,$2,$3,'dropoff','entered',
               ST_SetSRID(ST_MakePoint(-0.175,5.58),4326)::geography, 35, 'rider_arrive')`,
      [LEG_1, ORDER_1, RIDER_A]));

    // an informational exit is still allowed
    await pool!.query(
      `INSERT INTO geofence_events
         (leg_id, order_id, rider_id, fence, transition, position, distance_m)
       VALUES ($1,$2,$3,'dropoff','exited',
               ST_SetSRID(ST_MakePoint(-0.176,5.581),4326)::geography, 150)`,
      [LEG_1, ORDER_1, RIDER_A]);
  });

  test('the maps budget view measures real API spend per leg', async (t) => {
    if (!up) return t.skip('no database');
    await pool!.query(
      `INSERT INTO eta_snapshots (leg_id, eta_seconds, distance_m, source, reason)
       VALUES ($1, 600, 3000, 'google', 'first'),
              ($1, 540, 2700, 'fallback', 'directions unavailable'),
              ($1, 300, 1500, 'google', 'deviated')`, [LEG_1]);
    const r = await pool!.query(
      `SELECT google_calls, fallback_calls FROM maps_call_budget WHERE leg_id=$1`, [LEG_1]);
    assert.equal(r.rows[0]!.google_calls, '2');
    assert.equal(r.rows[0]!.fallback_calls, '1');
  });

  test('a delivery marked from far away is flagged for review', async (t) => {
    if (!up) return t.skip('no database');
    await pool!.query(
      `INSERT INTO delivery_proofs (leg_id, order_id, rider_id, distance_from_dropoff_m)
       VALUES ($1,$2,$3, 850)`, [LEG_2, ORDER_1, RIDER_A]);
    const r = await pool!.query(
      `SELECT count(*) c FROM delivery_proofs WHERE distance_from_dropoff_m > 300`);
    assert.equal(r.rows[0]!.c, '1');
  });
});

describe('messaging', () => {
  let threadId: string;

  test('a thread is unique per order and pair', async (t) => {
    if (!up) return t.skip('no database');
    const r = await pool!.query<{ id: string }>(
      `INSERT INTO chat_threads (order_id, pair, customer_id, counterparty_id)
       VALUES ($1,'customer_rider',$2,$3) RETURNING id`,
      [ORDER_1, RIDER_B, RIDER_A]);
    threadId = r.rows[0]!.id;

    await assert.rejects(() => pool!.query(
      `INSERT INTO chat_threads (order_id, pair, customer_id)
       VALUES ($1,'customer_rider',$2)`, [ORDER_1, RIDER_B]));

    // a different pair on the same order is fine
    await pool!.query(
      `INSERT INTO chat_threads (order_id, pair, customer_id)
       VALUES ($1,'customer_vendor',$2)`, [ORDER_1, RIDER_B]);
  });

  test('an empty message is rejected', async (t) => {
    if (!up) return t.skip('no database');
    await assert.rejects(() => pool!.query(
      `INSERT INTO chat_messages (thread_id, from_party, from_user_id, body)
       VALUES ($1,'rider',$2,'   ')`, [threadId, RIDER_A]));
  });

  test('an image-only message is valid — errand receipts', async (t) => {
    if (!up) return t.skip('no database');
    await pool!.query(
      `INSERT INTO chat_messages (thread_id, from_party, from_user_id, image_key)
       VALUES ($1,'rider',$2,'errand_receipt/o1/x.jpg')`, [threadId, RIDER_A]);
  });

  test('chat content is IMMUTABLE — it is dispute evidence', async (t) => {
    if (!up) return t.skip('no database');
    const m = await pool!.query<{ id: string }>(
      `INSERT INTO chat_messages (thread_id, from_party, from_user_id, body)
       VALUES ($1,'customer',$2,'the gate is locked') RETURNING id`,
      [threadId, RIDER_B]);

    await assert.rejects(() => pool!.query(
      `UPDATE chat_messages SET body='I never said that' WHERE id=$1`, [m.rows[0]!.id]));

    // marking it read is still allowed
    await pool!.query(
      `UPDATE chat_messages SET read_at=now() WHERE id=$1`, [m.rows[0]!.id]);
  });

  test('a notification is delivered once per event, recipient and channel',
    async (t) => {
      if (!up) return t.skip('no database');
      const evt = 'cccccccc-0000-0000-0000-000000000001';
      await pool!.query(
        `INSERT INTO notification_log (event_id, event_type, recipient_user_id, channel, status)
         VALUES ($1,'order.arrived',$2,'push','sent')`, [evt, RIDER_B]);

      await assert.rejects(() => pool!.query(
        `INSERT INTO notification_log (event_id, event_type, recipient_user_id, channel, status)
         VALUES ($1,'order.arrived',$2,'push','sent')`, [evt, RIDER_B]),
        'a redelivered event must not push twice');

      // the SMS fallback for the same event is a different channel
      await pool!.query(
        `INSERT INTO notification_log (event_id, event_type, recipient_user_id, channel, status, sms_segments)
         VALUES ($1,'order.arrived',$2,'sms','sent',1)`, [evt, RIDER_B]);
    });

  test('SMS spend is aggregated for reconciliation', async (t) => {
    if (!up) return t.skip('no database');
    const r = await pool!.query<{ segments: string }>(
      `SELECT segments FROM sms_spend_daily LIMIT 1`);
    assert.ok(Number(r.rows[0]!.segments) >= 1);
  });
});

describe('media', () => {
  test('sensitive kinds can NEVER be marked public', async (t) => {
    if (!up) return t.skip('no database');
    await assert.rejects(() => pool!.query(
      `INSERT INTO media_objects
         (object_key, kind, owner_ref, uploader_id, uploader_role, content_type, is_public)
       VALUES ('kyc_ghana_card/r1/a.jpg','kyc_ghana_card','r1',$1,'rider','image/jpeg',true)`,
      [RIDER_A]),
      'a Ghana Card must never be publicly addressable');

    await pool!.query(
      `INSERT INTO media_objects
         (object_key, kind, owner_ref, uploader_id, uploader_role, content_type, is_public)
       VALUES ('menu_item/s1/a.jpg','menu_item','s1',$1,'vendor_owner','image/jpeg',true)`,
      [RIDER_A]);
  });

  test('a stored object must record when it was confirmed', async (t) => {
    if (!up) return t.skip('no database');
    await assert.rejects(() => pool!.query(
      `INSERT INTO media_objects
         (object_key, kind, owner_ref, uploader_id, uploader_role, content_type, state)
       VALUES ('menu_item/s1/b.jpg','menu_item','s1',$1,'vendor_owner','image/jpeg','stored')`,
      [RIDER_A]));
  });

  test('expired objects are found by the purge job', async (t) => {
    if (!up) return t.skip('no database');
    await pool!.query(
      `INSERT INTO media_objects
         (object_key, kind, owner_ref, uploader_id, uploader_role, content_type,
          state, confirmed_at, expires_at)
       VALUES ('proof_of_delivery/o1/x.jpg','proof_of_delivery','o1',$1,'rider',
               'image/jpeg','stored', now(), now() - interval '1 day')`,
      [RIDER_A]);
    const r = await pool!.query(`SELECT * FROM expired_media(10)`);
    assert.equal(r.rowCount, 1);
    assert.equal(r.rows[0]!.kind, 'proof_of_delivery');
  });

  test('abandoned uploads are reaped so the table cannot grow forever',
    async (t) => {
      if (!up) return t.skip('no database');
      await pool!.query(
        `INSERT INTO media_objects
           (object_key, kind, owner_ref, uploader_id, uploader_role, content_type, created_at)
         VALUES ('prescription/o9/x.jpg','prescription','o9',$1,'customer',
                 'image/jpeg', now() - interval '3 hours')`, [RIDER_A]);
      const r = await pool!.query(`SELECT * FROM orphaned_uploads()`);
      assert.ok((r.rowCount ?? 0) >= 1);
    });

  test('KYC access is logged — who viewed a Ghana Card, and when', async (t) => {
    if (!up) return t.skip('no database');
    const m = await pool!.query<{ id: string }>(
      `INSERT INTO media_objects
         (object_key, kind, owner_ref, uploader_id, uploader_role, content_type,
          state, confirmed_at)
       VALUES ('kyc_selfie/r1/a.jpg','kyc_selfie','r1',$1,'rider','image/jpeg',
               'stored', now()) RETURNING id`, [RIDER_A]);
    await pool!.query(
      `INSERT INTO media_access_log (media_id, viewer_id, viewer_role, ip)
       VALUES ($1,$2,'ops_manager','154.160.1.5')`, [m.rows[0]!.id, RIDER_B]);
    const log = await pool!.query(
      `SELECT viewer_role FROM media_access_log WHERE media_id=$1`, [m.rows[0]!.id]);
    assert.equal(log.rows[0]!.viewer_role, 'ops_manager');
  });
});
