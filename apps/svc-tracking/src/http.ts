/**
 * tracking-svc HTTP surface.
 *
 * The WebSocket carries live positions; this REST surface handles everything
 * that is not a stream: ingesting pings, answering "where is my order" on
 * reconnect, and proof of delivery.
 *
 * Ping ingestion is the highest-volume write in the platform — a rider on an
 * active delivery posts every 5 seconds — so the handler does the cheap
 * validation first and never blocks on a broadcast.
 */

import 'reflect-metadata';
import {
  Module, Controller, Get, Post, Body, Param, Headers,
  Inject, type DynamicModule,
} from '@nestjs/common';
import type { Pool } from 'pg';

import { HealthModule } from '../../../libs/platform/src/service/bootstrap.ts';
import { PgTrackingStore } from './pg-tracking-store.ts';
import {
  ValidationError, UnauthorizedError, ForbiddenError, NotFoundError,
} from '../../../libs/platform/src/errors.ts';
import {
  processPing, assertValidPing, pingIntervalSeconds, canWatchOrder,
  TrackingHub, GEOFENCE_RADIUS_METRES,
  PING_INTERVAL_ACTIVE_SECONDS, PING_INTERVAL_IDLE_SECONDS,
  type Ping, type RiderTrack, type Geofence, type OrderParticipants,
  type PingRejection, type Subscriber,
} from './tracking.ts';

export const TRACKING_STORE = Symbol('TRACKING_STORE');
export const TRACKING_HUB = Symbol('TRACKING_HUB');
export const VERIFY_TOKEN = Symbol('TRACKING_VERIFY_TOKEN');

export interface Claims { sub: string; role: string }
export type VerifyToken = (token: string) => Claims;

/**
 * Everything tracking needs to persist. Rejected pings are stored as well as
 * accepted ones — a cluster of mock_location rejections is a fraud signal and
 * throwing them away destroys the evidence (issue #15).
 */
export interface TrackingStore {
  lastTrack(riderId: string): Promise<RiderTrack | null>;
  saveTrack(track: RiderTrack): Promise<void>;
  recordRejection(riderId: string, ping: Ping, reason: PingRejection): Promise<void>;
  /** The active leg's fences, or [] when the rider is idle. */
  fencesFor(riderId: string): Promise<{ orderId: string | null; fences: Geofence[] }>;
  participants(orderId: string): Promise<OrderParticipants | null>;
  savePod(orderId: string, pod: {
    riderId: string; lat: number; lng: number;
    photoUrl?: string; recipientName?: string; distanceMetres: number;
  }): Promise<void>;
}

export class InMemoryTrackingStore implements TrackingStore {
  tracks = new Map<string, RiderTrack>();
  rejections: Array<{ riderId: string; reason: PingRejection; atMs: number }> = [];
  legs = new Map<string, { orderId: string | null; fences: Geofence[] }>();
  orders = new Map<string, OrderParticipants>();
  pods: Array<Record<string, unknown>> = [];

  async lastTrack(riderId: string) { return this.tracks.get(riderId) ?? null; }
  async saveTrack(track: RiderTrack) { this.tracks.set(track.riderId, track); }
  async recordRejection(riderId: string, ping: Ping, reason: PingRejection) {
    this.rejections.push({ riderId, reason, atMs: ping.atMs });
  }
  async fencesFor(riderId: string) {
    return this.legs.get(riderId) ?? { orderId: null, fences: [] };
  }
  async participants(orderId: string) { return this.orders.get(orderId) ?? null; }
  async savePod(orderId: string, pod: Record<string, unknown>) {
    this.pods.push({ orderId, ...pod });
  }
}

function requireFields(body: any, fields: string[]): void {
  const errors: Record<string, string[]> = {};
  for (const f of fields) {
    if (body?.[f] === undefined || body[f] === null || body[f] === '') errors[f] = ['is required'];
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
}

/* ------------------------------------------------------------------ */

@Controller('tracking')
export class TrackingController {
  constructor(
    @Inject(TRACKING_STORE) private readonly store: TrackingStore,
    @Inject(TRACKING_HUB) private readonly hub: TrackingHub,
    @Inject(VERIFY_TOKEN) private readonly verify: VerifyToken,
  ) {}

  private claims(auth?: string): Claims {
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedError();
    try { return this.verify(auth.slice(7)); }
    catch { throw new UnauthorizedError('Invalid token'); }
  }

  private riderClaims(auth?: string): Claims {
    const c = this.claims(auth);
    if (c.role !== 'rider') throw new ForbiddenError('Riders only');
    return c;
  }

  /**
   * Ingest one position.
   *
   * Always 201, even for a rejected ping: the rider's phone cannot fix a bad
   * GPS fix by retrying, and turning this into a 4xx would make the app
   * retry-storm on exactly the flaky networks where it already struggles.
   * The body says whether it was accepted.
   */
  @Post('pings')
  async ping(@Body() body: any, @Headers('authorization') auth?: string) {
    const c = this.riderClaims(auth);
    requireFields(body, ['lat', 'lng', 'atMs']);

    const ping: Ping = {
      riderId: c.sub,
      position: { lat: Number(body.lat), lng: Number(body.lng) },
      atMs: Number(body.atMs),
      ...(body.accuracyMetres !== undefined
        ? { accuracyMetres: Number(body.accuracyMetres) } : {}),
      ...(body.speedMps !== undefined ? { speedMps: Number(body.speedMps) } : {}),
      ...(body.isMockLocation !== undefined
        ? { isMockLocation: body.isMockLocation === true } : {}),
    };
    assertValidPing(ping);

    const previous = await this.store.lastTrack(c.sub);
    const leg = await this.store.fencesFor(c.sub);
    const result = processPing(previous, ping, leg.fences);

    if (!result.accepted) {
      // Stored, not discarded — this is the fraud trail.
      await this.store.recordRejection(c.sub, ping, result.rejection!);
      return {
        accepted: false,
        rejection: result.rejection,
        nextPingSeconds: pingIntervalSeconds(leg.orderId !== null),
      };
    }

    await this.store.saveTrack({
      riderId: c.sub,
      last: ping,
      legDistanceMetres: (previous?.legDistanceMetres ?? 0) + result.movedMetres,
    });

    // Fan out to watchers. Throttling inside the hub means a `false` here is
    // normal, not a failure, so it is deliberately not surfaced as an error.
    if (leg.orderId) {
      this.hub.broadcast(leg.orderId, {
        position: ping.position,
        etaSeconds: Number(body.etaSeconds ?? 0),
        state: String(body.state ?? 'in_transit'),
      });
    }

    return {
      accepted: true,
      movedMetres: Math.round(result.movedMetres),
      geofenceEvents: result.geofenceEvents,
      // The app adapts its GPS duty cycle from this — the single biggest
      // lever on rider battery life.
      nextPingSeconds: pingIntervalSeconds(leg.orderId !== null),
    };
  }

  /**
   * Where is this order right now? Used on app launch and after a socket
   * drop, so the map has something to draw before the first live frame.
   */
  @Get('orders/:orderId/position')
  async position(@Param('orderId') orderId: string, @Headers('authorization') auth?: string) {
    const c = this.claims(auth);
    const order = await this.store.participants(orderId);
    if (!order) throw new NotFoundError('Order');

    const verdict = canWatchOrder(c.sub, c.role as Subscriber['role'], order);
    if (!verdict.allowed) {
      // 404 rather than 403: confirming an order exists to a stranger is a
      // leak in itself.
      throw new NotFoundError('Order');
    }
    if (!order.riderId) {
      return { orderId, riderAssigned: false, position: null };
    }

    const track = await this.store.lastTrack(order.riderId);
    if (!track) return { orderId, riderAssigned: true, position: null };

    return {
      orderId,
      riderAssigned: true,
      position: track.last.position,
      atMs: track.last.atMs,
      // The app greys out a stale dot rather than pretending it is live.
      ageSeconds: Math.max(0, Math.round((Date.now() - track.last.atMs) / 1000)),
      legDistanceMetres: Math.round(track.legDistanceMetres),
    };
  }

  /**
   * Proof of delivery. The rider's distance from the dropoff is recorded
   * whether or not it is within the geofence — a POD filed 800m away is the
   * evidence that settles a "never arrived" dispute.
   */
  @Post('orders/:orderId/pod')
  async pod(
    @Param('orderId') orderId: string, @Body() body: any,
    @Headers('authorization') auth?: string,
  ) {
    const c = this.riderClaims(auth);
    requireFields(body, ['lat', 'lng']);

    const order = await this.store.participants(orderId);
    if (!order) throw new NotFoundError('Order');
    if (order.riderId !== c.sub) {
      throw new ForbiddenError('You are not the rider on this delivery');
    }

    const leg = await this.store.fencesFor(c.sub);
    const dropoff = leg.fences.find((f) => f.name === 'dropoff');
    const here = { lat: Number(body.lat), lng: Number(body.lng) };
    const distance = dropoff
      ? haversine(here, dropoff.centre)
      : 0;

    await this.store.savePod(orderId, {
      riderId: c.sub,
      lat: here.lat,
      lng: here.lng,
      distanceMetres: Math.round(distance),
      ...(body.photoUrl ? { photoUrl: String(body.photoUrl) } : {}),
      ...(body.recipientName ? { recipientName: String(body.recipientName) } : {}),
    });

    const withinGeofence = distance <= GEOFENCE_RADIUS_METRES;
    return {
      orderId,
      recorded: true,
      distanceMetres: Math.round(distance),
      withinGeofence,
      // Not a rejection: the delivery may be legitimate (a customer who
      // walked out to the road). It is flagged for review instead.
      ...(withinGeofence ? {} : { flagged: 'pod_outside_geofence' }),
    };
  }

  /** How often should this rider report? Read once on going online. */
  @Get('config')
  config() {
    return {
      activePingSeconds: PING_INTERVAL_ACTIVE_SECONDS,
      idlePingSeconds: PING_INTERVAL_IDLE_SECONDS,
      geofenceRadiusMetres: GEOFENCE_RADIUS_METRES,
    };
  }
}

/** Local copy so the controller does not import the maps lib for one call. */
function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/* ------------------------------------------------------------------ */

export interface TrackingDeps {
  pool?: Pool | null;
  store?: TrackingStore;
  hub?: TrackingHub;
  verifyToken?: VerifyToken;
}

@Module({})
export class TrackingHttpModule {
  static forRoot(deps: TrackingDeps = {}): DynamicModule {
    const pool = deps.pool ?? null;
    // An explicit store wins; otherwise a pool means PERSIST and no pool
    // means memory. Previously a caller could pass a pool and still silently
    // get the in-memory store — the service looked configured for Postgres
    // and quietly threw every ping away.
    const store = deps.store
      ?? (pool ? new PgTrackingStore(pool) : new InMemoryTrackingStore());
    const hub = deps.hub ?? new TrackingHub();
    const verify: VerifyToken = deps.verifyToken ?? (() => {
      throw new UnauthorizedError('token verification is not configured');
    });

    return {
      module: TrackingHttpModule,
      imports: [HealthModule.forRoot(pool)],
      controllers: [TrackingController],
      providers: [
        { provide: TRACKING_STORE, useValue: store },
        { provide: TRACKING_HUB, useValue: hub },
        { provide: VERIFY_TOKEN, useValue: verify },
      ],
    };
  }
}
