/**
 * Postgres/PostGIS implementation of TrackingStore.
 *
 * Until now every rider ping lived in a `Map` and died with the process. That
 * is not merely "state loss on restart" — three specific things were broken:
 *
 *   1. **No breadcrumb trail.** When a customer says "the rider never came",
 *      the trail is the evidence. Without it the argument is unwinnable in
 *      both directions.
 *   2. **No fraud signal.** `rider_pings` deliberately stores REJECTED pings
 *      too. One mock-location rejection is a flaky phone; forty from the same
 *      rider is a pattern, and the pattern only exists if the rows do.
 *   3. **A restart re-opened every geofence.** With last-position in memory,
 *      a redeploy meant the next ping had no `previous`, so the arrival fence
 *      could fire a second time and auto-advance an order twice.
 *
 * PostGIS carries its weight here: `ST_DWithin` on a `GEOGRAPHY` column does
 * metre-accurate distance on the spheroid. Doing it in Node means pulling
 * candidate rows over the wire to compute haversine in JavaScript.
 */

import type { Pool, PoolClient } from 'pg';

import type {
  Ping, PingRejection, RiderTrack, Geofence, OrderParticipants,
} from './tracking.ts';
import type { TrackingStore } from './http.ts';

/** `POINT(lng lat)` — PostGIS is longitude-first, which is the reverse of
 *  every mapping API we talk to. Getting it backwards silently places every
 *  Accra rider in the Atlantic, so it lives in one function. */
function point(lat: number, lng: number): string {
  return `SRID=4326;POINT(${lng} ${lat})`;
}

export class PgTrackingStore implements TrackingStore {
  constructor(private readonly pool: Pool) {}

  /**
   * The rider's last ACCEPTED position.
   *
   * Rejected pings are excluded deliberately: if a spoofed jump became the
   * baseline, the *next* genuine ping would look like an implausible jump
   * back and be rejected too. One bad fix would knock a rider offline for the
   * rest of the delivery.
   */
  async lastTrack(riderId: string): Promise<RiderTrack | null> {
    const { rows } = await this.pool.query<{
      lat: string; lng: string; recorded_at: Date;
      accuracy_m: number | null; speed_mps: number | null;
      leg_distance_m: string | null;
    }>(
      `SELECT ST_Y(position::geometry) AS lat,
              ST_X(position::geometry) AS lng,
              recorded_at, accuracy_m, speed_mps,
              leg_distance_m
         FROM rider_pings
        WHERE rider_id = $1 AND outcome = 'accepted'
        ORDER BY recorded_at DESC
        LIMIT 1`,
      [riderId],
    );

    const r = rows[0];
    if (!r) return null;

    return {
      riderId,
      last: {
        riderId,
        position: { lat: Number(r.lat), lng: Number(r.lng) },
        atMs: r.recorded_at.getTime(),
        ...(r.accuracy_m !== null ? { accuracyMetres: r.accuracy_m } : {}),
        ...(r.speed_mps !== null ? { speedMps: r.speed_mps } : {}),
      },
      legDistanceMetres: Number(r.leg_distance_m ?? 0),
    };
  }

  /**
   * Append an accepted ping.
   *
   * INSERT, never UPDATE — the table is a partitioned append-only trail. The
   * running leg distance is denormalised onto the row so `lastTrack` stays a
   * single indexed read rather than a sum over the leg.
   */
  async saveTrack(track: RiderTrack): Promise<void> {
    const legId = await this.activeLegId(track.riderId);
    await this.pool.query(
      `INSERT INTO rider_pings
         (rider_id, leg_id, position, accuracy_m, speed_mps,
          outcome, recorded_at, leg_distance_m)
       VALUES ($1, $2, ST_GeogFromText($3), $4, $5,
               'accepted', to_timestamp($6::double precision / 1000), $7)`,
      [
        track.riderId,
        legId,
        point(track.last.position.lat, track.last.position.lng),
        track.last.accuracyMetres ?? null,
        track.last.speedMps ?? null,
        track.last.atMs,
        Math.round(track.legDistanceMetres),
      ],
    );
  }

  /**
   * Store a REJECTED ping.
   *
   * The instinct is to drop these. Don't: `pings_rejected_idx` is a partial
   * index built for exactly this scan, and a cluster of `mock_location`
   * rejections from one rider is the clearest fraud signal the platform has.
   * A rejected ping that was never written is a fraud case that cannot be
   * made.
   */
  async recordRejection(
    riderId: string, ping: Ping, reason: PingRejection,
  ): Promise<void> {
    const legId = await this.activeLegId(riderId);
    await this.pool.query(
      `INSERT INTO rider_pings
         (rider_id, leg_id, position, accuracy_m, speed_mps,
          outcome, recorded_at)
       VALUES ($1, $2, ST_GeogFromText($3), $4, $5,
               $6::ping_rejection, to_timestamp($7::double precision / 1000))`,
      [
        riderId,
        legId,
        point(ping.position.lat, ping.position.lng),
        ping.accuracyMetres ?? null,
        ping.speedMps ?? null,
        reason,
        ping.atMs,
      ],
    );
  }

  /**
   * The active leg's geofences.
   *
   * Reads from the dispatch-owned `active_legs` projection rather than
   * calling dispatch-svc: this runs on every ping from every online rider,
   * and a cross-service HTTP call on that path would be the first thing to
   * fall over at dinner time.
   */
  async fencesFor(
    riderId: string,
  ): Promise<{ orderId: string | null; fences: Geofence[] }> {
    const { rows } = await this.pool.query<{
      order_id: string;
      pickup_lat: string | null; pickup_lng: string | null;
      dropoff_lat: string | null; dropoff_lng: string | null;
      pickup_radius_m: number | null; dropoff_radius_m: number | null;
      pickup_fired: boolean; dropoff_fired: boolean;
    }>(
      `SELECT l.order_id,
              ST_Y(l.pickup_position::geometry)  AS pickup_lat,
              ST_X(l.pickup_position::geometry)  AS pickup_lng,
              ST_Y(l.dropoff_position::geometry) AS dropoff_lat,
              ST_X(l.dropoff_position::geometry) AS dropoff_lng,
              l.pickup_radius_m, l.dropoff_radius_m,
              EXISTS (SELECT 1 FROM geofence_events g
                       WHERE g.leg_id = l.leg_id AND g.fence = 'pickup'
                         AND g.transition = 'entered'
                         AND g.emitted_event IS NOT NULL) AS pickup_fired,
              EXISTS (SELECT 1 FROM geofence_events g
                       WHERE g.leg_id = l.leg_id AND g.fence = 'dropoff'
                         AND g.transition = 'entered'
                         AND g.emitted_event IS NOT NULL) AS dropoff_fired
         FROM active_legs l
        WHERE l.rider_id = $1 AND l.completed_at IS NULL
        ORDER BY l.assigned_at DESC
        LIMIT 1`,
      [riderId],
    );

    const r = rows[0];
    if (!r) return { orderId: null, fences: [] };

    const fences: Geofence[] = [];
    if (r.pickup_lat !== null && r.pickup_lng !== null) {
      fences.push({
        name: 'pickup',
        centre: { lat: Number(r.pickup_lat), lng: Number(r.pickup_lng) },
        radiusMetres: r.pickup_radius_m ?? 100,
        // Once the arrival event has fired, the fence stays but stops
        // emitting. A rider who steps away and comes back must not advance
        // the order a second time — the DB, not process memory, is what
        // remembers that across a redeploy.
        ...(r.pickup_fired ? {} : { emitEvent: 'rider_arrive_vendor' }),
      });
    }
    if (r.dropoff_lat !== null && r.dropoff_lng !== null) {
      fences.push({
        name: 'dropoff',
        centre: { lat: Number(r.dropoff_lat), lng: Number(r.dropoff_lng) },
        radiusMetres: r.dropoff_radius_m ?? 100,
        ...(r.dropoff_fired ? {} : { emitEvent: 'rider_arrive_customer' }),
      });
    }

    return { orderId: r.order_id, fences };
  }

  /**
   * Record a geofence crossing.
   *
   * Returns false when this crossing was already recorded. The unique index
   * `geofence_one_entry_per_fence` is the real guard — two pings arriving
   * concurrently from a reconnecting phone would otherwise both pass a
   * check-then-insert. Let the database arbitrate and treat the conflict as
   * a normal outcome rather than an error.
   */
  async recordGeofenceEvent(input: {
    legId: string; orderId: string; riderId: string;
    fence: 'pickup' | 'dropoff'; transition: 'entered' | 'exited';
    lat: number; lng: number; distanceMetres: number;
    emittedEvent?: string;
  }): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO geofence_events
         (leg_id, order_id, rider_id, fence, transition,
          position, distance_m, emitted_event)
       VALUES ($1, $2, $3, $4::fence_kind, $5::fence_transition,
               ST_GeogFromText($6), $7, $8)
       ON CONFLICT DO NOTHING`,
      [
        input.legId, input.orderId, input.riderId,
        input.fence, input.transition,
        point(input.lat, input.lng),
        Math.round(input.distanceMetres),
        input.emittedEvent ?? null,
      ],
    );
    return (rowCount ?? 0) > 0;
  }

  async participants(orderId: string): Promise<OrderParticipants | null> {
    const { rows } = await this.pool.query<{
      order_id: string; customer_id: string; rider_id: string | null;
      vendor_id: string | null; state: string;
    }>(
      `SELECT order_id, customer_id, rider_id, vendor_id, state
         FROM order_participants
        WHERE order_id = $1`,
      [orderId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      orderId: r.order_id,
      customerId: r.customer_id,
      riderId: r.rider_id,
      vendorId: r.vendor_id,
      state: r.state,
    } as OrderParticipants;
  }

  /**
   * Proof of delivery.
   *
   * `distance_from_dropoff_m` is computed by PostGIS from the two points
   * rather than trusted from the client — the whole value of the number is
   * that the rider's app did not get to choose it. A partial index already
   * watches for values over 300m.
   */
  async savePod(orderId: string, pod: {
    riderId: string; lat: number; lng: number;
    photoUrl?: string; recipientName?: string; distanceMetres: number;
  }): Promise<void> {
    const legId = await this.activeLegId(pod.riderId);
    await this.pool.query(
      `INSERT INTO delivery_proofs
         (leg_id, order_id, rider_id, photo_keys, position,
          distance_from_dropoff_m, recipient_name)
       VALUES ($1, $2, $3, $4::jsonb, ST_GeogFromText($5), $6, $7)
       ON CONFLICT (leg_id) DO UPDATE
          SET photo_keys = EXCLUDED.photo_keys,
              position   = EXCLUDED.position,
              distance_from_dropoff_m = EXCLUDED.distance_from_dropoff_m,
              recipient_name = EXCLUDED.recipient_name`,
      [
        legId ?? orderId,
        orderId,
        pod.riderId,
        JSON.stringify(pod.photoUrl ? [pod.photoUrl] : []),
        point(pod.lat, pod.lng),
        Math.round(pod.distanceMetres),
        pod.recipientName ?? null,
      ],
    );
  }

  /**
   * The breadcrumb trail for one leg — the dispute-resolution query.
   * Ordered oldest-first because it is drawn as a path, not a list.
   */
  async trailFor(
    legId: string, limit = 500,
  ): Promise<Array<{ lat: number; lng: number; atMs: number; outcome: string }>> {
    const { rows } = await this.pool.query<{
      lat: string; lng: string; recorded_at: Date; outcome: string;
    }>(
      `SELECT ST_Y(position::geometry) AS lat,
              ST_X(position::geometry) AS lng,
              recorded_at, outcome
         FROM rider_pings
        WHERE leg_id = $1
        ORDER BY recorded_at ASC
        LIMIT $2`,
      [legId, limit],
    );
    return rows.map((r) => ({
      lat: Number(r.lat),
      lng: Number(r.lng),
      atMs: r.recorded_at.getTime(),
      outcome: r.outcome,
    }));
  }

  /**
   * Rejected pings for one rider — the fraud-review query.
   * This is why rejections are stored at all.
   */
  async rejectionsFor(
    riderId: string, sinceMs: number,
  ): Promise<Array<{ reason: string; count: number }>> {
    const { rows } = await this.pool.query<{ outcome: string; n: string }>(
      `SELECT outcome, count(*) AS n
         FROM rider_pings
        WHERE rider_id = $1
          AND outcome <> 'accepted'
          AND recorded_at >= to_timestamp($2::double precision / 1000)
        GROUP BY outcome
        ORDER BY n DESC`,
      [riderId, sinceMs],
    );
    return rows.map((r) => ({ reason: r.outcome, count: Number(r.n) }));
  }

  /** The rider's current leg, or null when idle. */
  private async activeLegId(riderId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ leg_id: string }>(
      `SELECT leg_id FROM active_legs
        WHERE rider_id = $1 AND completed_at IS NULL
        ORDER BY assigned_at DESC LIMIT 1`,
      [riderId],
    );
    return rows[0]?.leg_id ?? null;
  }
}

/**
 * Transactional variant, for callers that already hold a client.
 * Only used where a ping and its geofence event must land together.
 */
export function withClient(client: PoolClient): PgTrackingStore {
  return new PgTrackingStore({
    query: client.query.bind(client),
  } as unknown as Pool);
}
