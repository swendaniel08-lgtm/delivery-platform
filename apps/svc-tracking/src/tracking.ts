/**
 * Live tracking. PDF §9.
 *
 * Rider GPS → Redis (hot position) → WebSocket fanout to the one customer
 * watching that order. Geofence crossings auto-advance the order state so
 * riders don't have to tap "arrived" while driving.
 *
 * Two things this must not do:
 *   - call Google on every ping (that was issue #8; we reuse the throttle)
 *   - broadcast a rider's position to anyone but the customer on that order
 */

import { haversineMetres, type LatLng } from '../../../libs/maps/src/geohash.ts';
import { ValidationError } from '../../../libs/platform/src/errors.ts';

/** PDF §9: 5 s while on a delivery, 30 s while idle. */
export const PING_INTERVAL_ACTIVE_SECONDS = 5;
export const PING_INTERVAL_IDLE_SECONDS = 30;

/** Radius at which we consider the rider "at" a location. */
export const GEOFENCE_RADIUS_METRES = 100;

/** Anything faster than this is a GPS glitch or a spoof (200 km/h). */
export const MAX_PLAUSIBLE_SPEED_MPS = 55;

export interface Ping {
  riderId: string;
  position: LatLng;
  /** Client timestamp, milliseconds. */
  atMs: number;
  accuracyMetres?: number;
  speedMps?: number;
  /** Android/iOS mock-location flag — fraud signal (issue #15 groundwork). */
  isMockLocation?: boolean;
}

export interface RiderTrack {
  riderId: string;
  last: Ping;
  /** Distance covered on the current leg, metres. */
  legDistanceMetres: number;
}

export type PingRejection =
  | 'stale' | 'implausible_jump' | 'mock_location' | 'poor_accuracy' | 'out_of_bounds';

export interface PingResult {
  accepted: boolean;
  rejection?: PingRejection;
  /** Metres moved since the previous accepted ping. */
  movedMetres: number;
  geofenceEvents: GeofenceEvent[];
}

export interface Geofence {
  name: 'pickup' | 'dropoff';
  centre: LatLng;
  radiusMetres: number;
  /** Order event to emit on entry, if any. */
  emitEvent?: string;
}

export interface GeofenceEvent {
  fence: 'pickup' | 'dropoff';
  transition: 'entered' | 'exited';
  emitEvent?: string;
}

/** Accra bounding box — a ping outside Ghana is a bug or a spoof. */
const GHANA = { minLat: 4.5, maxLat: 11.2, minLng: -3.3, maxLng: 1.25 };

/**
 * Validate and apply a ping.
 *
 * Rejecting bad pings matters more than it sounds: a single spoofed jump can
 * trigger a geofence, auto-mark an order delivered, and settle money to a
 * rider who never arrived.
 */
export function processPing(
  previous: RiderTrack | null,
  ping: Ping,
  fences: Geofence[] = [],
  nowMs: number = Date.now(),
): PingResult {
  const none = { accepted: false, movedMetres: 0, geofenceEvents: [] as GeofenceEvent[] };

  if (ping.isMockLocation) return { ...none, rejection: 'mock_location' };

  if (ping.position.lat < GHANA.minLat || ping.position.lat > GHANA.maxLat ||
      ping.position.lng < GHANA.minLng || ping.position.lng > GHANA.maxLng) {
    return { ...none, rejection: 'out_of_bounds' };
  }

  // Reject wildly inaccurate fixes; they cause phantom geofence crossings.
  if (ping.accuracyMetres !== undefined && ping.accuracyMetres > 200) {
    return { ...none, rejection: 'poor_accuracy' };
  }

  // Ignore pings older than the last accepted one (out-of-order delivery).
  if (previous && ping.atMs <= previous.last.atMs) {
    return { ...none, rejection: 'stale' };
  }

  let moved = 0;
  if (previous) {
    moved = haversineMetres(previous.last.position, ping.position);
    const seconds = (ping.atMs - previous.last.atMs) / 1000;
    if (seconds > 0) {
      const impliedSpeed = moved / seconds;
      // allow a grace distance for GPS jitter when stationary
      if (impliedSpeed > MAX_PLAUSIBLE_SPEED_MPS && moved > 100) {
        return { ...none, rejection: 'implausible_jump', movedMetres: moved };
      }
    }
  }

  const geofenceEvents: GeofenceEvent[] = [];
  for (const fence of fences) {
    const distNow = haversineMetres(ping.position, fence.centre);
    const inside = distNow <= fence.radiusMetres;
    const wasInside = previous
      ? haversineMetres(previous.last.position, fence.centre) <= fence.radiusMetres
      : false;

    if (inside && !wasInside) {
      geofenceEvents.push({
        fence: fence.name, transition: 'entered',
        ...(fence.emitEvent ? { emitEvent: fence.emitEvent } : {}),
      });
    } else if (!inside && wasInside) {
      geofenceEvents.push({ fence: fence.name, transition: 'exited' });
    }
  }

  return { accepted: true, movedMetres: moved, geofenceEvents };
}

/* ------------------------------------------------------------------ */
/* Subscription fanout                                                 */
/* ------------------------------------------------------------------ */

export interface Subscriber {
  /** Who is watching. */
  principalId: string;
  role: 'customer' | 'vendor' | 'admin';
  send(payload: unknown): void;
}

/**
 * Room-per-order fanout.
 *
 * Authorisation is enforced at subscribe time, not at broadcast time: a
 * customer may only join the room for their own active order. Otherwise
 * anyone could watch any rider move around Accra.
 */
export class TrackingHub {
  private rooms = new Map<string, Set<Subscriber>>();
  /** Throttle: last broadcast per order. */
  private lastBroadcastMs = new Map<string, number>();

  /** PDF §9 — customers see updates at most every 3 s, not every 5 s ping. */
  constructor(private readonly minBroadcastIntervalMs = 3_000) {}

  subscribe(orderId: string, sub: Subscriber): () => void {
    if (!this.rooms.has(orderId)) this.rooms.set(orderId, new Set());
    this.rooms.get(orderId)!.add(sub);
    return () => this.unsubscribe(orderId, sub);
  }

  unsubscribe(orderId: string, sub: Subscriber): void {
    const room = this.rooms.get(orderId);
    if (!room) return;
    room.delete(sub);
    if (room.size === 0) {
      this.rooms.delete(orderId);
      this.lastBroadcastMs.delete(orderId);
    }
  }

  subscriberCount(orderId: string): number {
    return this.rooms.get(orderId)?.size ?? 0;
  }

  /**
   * Push a position to everyone watching this order.
   * Returns false when throttled — the caller should not treat that as failure.
   */
  broadcast(orderId: string, payload: {
    position: LatLng; etaSeconds: number; state: string;
  }, nowMs: number = Date.now()): boolean {
    const room = this.rooms.get(orderId);
    if (!room || room.size === 0) return false;

    const last = this.lastBroadcastMs.get(orderId) ?? 0;
    if (nowMs - last < this.minBroadcastIntervalMs) return false;

    this.lastBroadcastMs.set(orderId, nowMs);
    for (const sub of room) sub.send({ orderId, ...payload });
    return true;
  }

  /** Order finished: close the room so no further positions leak. */
  closeRoom(orderId: string): number {
    const n = this.subscriberCount(orderId);
    this.rooms.delete(orderId);
    this.lastBroadcastMs.delete(orderId);
    return n;
  }
}

/* ------------------------------------------------------------------ */
/* Subscribe-time authorisation                                        */
/* ------------------------------------------------------------------ */

export interface OrderParticipants {
  customerId: string;
  vendorOwnerId: string | null;
  riderId: string | null;
  terminal: boolean;
}

export function canWatchOrder(
  principalId: string, role: Subscriber['role'], order: OrderParticipants,
): { allowed: boolean; reason?: string } {
  if (role === 'admin') return { allowed: true };
  if (order.terminal) {
    return { allowed: false, reason: 'this order has finished' };
  }
  if (role === 'customer') {
    return principalId === order.customerId
      ? { allowed: true }
      : { allowed: false, reason: 'not your order' };
  }
  if (role === 'vendor') {
    return principalId === order.vendorOwnerId
      ? { allowed: true }
      : { allowed: false, reason: 'not your order' };
  }
  return { allowed: false, reason: 'unknown role' };
}

/** Reported speed sanity — used by the rider app to pick a ping interval. */
export function pingIntervalSeconds(onActiveDelivery: boolean): number {
  return onActiveDelivery ? PING_INTERVAL_ACTIVE_SECONDS : PING_INTERVAL_IDLE_SECONDS;
}

export function assertValidPing(p: Ping): void {
  if (!Number.isFinite(p.position.lat) || !Number.isFinite(p.position.lng)) {
    throw new ValidationError({ position: ['lat and lng must be finite numbers'] });
  }
  if (!Number.isFinite(p.atMs) || p.atMs <= 0) {
    throw new ValidationError({ atMs: ['must be a positive timestamp'] });
  }
}
