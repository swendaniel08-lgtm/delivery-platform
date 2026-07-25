/**
 * dispatch-svc HTTP surface.
 *
 * Two very different callers:
 *   • order-svc asks us to find a rider for a leg (server-to-server)
 *   • the rider app polls its offers and taps Accept (thousands of phones)
 *
 * The accept endpoint is the one that matters. Three riders are offered the
 * same job and all three tap at once on a bad network; exactly one must win,
 * and the other two must get a clear "taken" rather than a 500 or, worse,
 * a second assignment of the same order.
 */

import 'reflect-metadata';
import {
  Module, Controller, Get, Post, Body, Param, Query, Headers,
  Inject, type DynamicModule,
} from '@nestjs/common';
import type { Pool } from 'pg';

import { HealthModule } from '../../../libs/platform/src/service/bootstrap.ts';
import {
  ValidationError, UnauthorizedError, ForbiddenError, NotFoundError, ConflictError,
} from '../../../libs/platform/src/errors.ts';
import {
  DispatchService, InMemoryClaimStore, isEligible, rankRiders, nextAction,
  DISPATCH_ROUNDS, VEHICLE_CAPABILITY,
  type ClaimStore, type RiderCandidate, type DispatchRequest, type VehicleType,
} from './dispatch.ts';

export const DISPATCH_SERVICE = Symbol('DISPATCH_SERVICE');
export const RIDER_SOURCE = Symbol('RIDER_SOURCE');
export const VERIFY_TOKEN = Symbol('DISPATCH_VERIFY_TOKEN');

export interface Claims { sub: string; role: string }
export type VerifyToken = (token: string) => Claims;

/**
 * Where candidate riders come from. In production this is the
 * `find_dispatch_candidates()` SQL function against the Redis GEO index;
 * in tests it is a list.
 */
export interface RiderSource {
  candidates(centre: { lat: number; lng: number }, radiusMetres: number):
    Promise<RiderCandidate[]>;
}

export class InMemoryRiderSource implements RiderSource {
  constructor(public riders: RiderCandidate[] = []) {}
  async candidates() { return this.riders; }
}

/** Reads candidates via the migration's `find_dispatch_candidates()`. */
export class PgRiderSource implements RiderSource {
  constructor(private readonly pool: Pool) {}

  async candidates(centre: { lat: number; lng: number }, radiusMetres: number) {
    const r = await this.pool.query(
      'SELECT * FROM find_dispatch_candidates($1, $2, $3)',
      [centre.lat, centre.lng, radiusMetres],
    );
    return r.rows.map((row: any): RiderCandidate => ({
      riderId: row.rider_id,
      position: { lat: Number(row.latitude), lng: Number(row.longitude) },
      vehicle: row.vehicle as VehicleType,
      isOnline: row.is_online,
      hasActiveLeg: row.has_active_leg,
      // BIGINT arrives as a string; BigInt() is the only safe conversion.
      codObligationPesewas: BigInt(row.cod_obligation_pesewas ?? '0'),
      acceptanceRate: Number(row.acceptance_rate ?? 0),
      cancellationsToday: Number(row.cancellations_today ?? 0),
    }));
  }
}

function requireFields(body: any, fields: string[]): void {
  const errors: Record<string, string[]> = {};
  for (const f of fields) {
    if (body?.[f] === undefined || body[f] === null || body[f] === '') errors[f] = ['is required'];
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
}

function parseRequest(body: any): DispatchRequest {
  requireFields(body, ['orderId', 'legId', 'service', 'pickup', 'dropoff']);
  const pt = (v: any, name: string) => {
    if (typeof v?.lat !== 'number' || typeof v?.lng !== 'number') {
      throw new ValidationError({ [name]: ['must be {lat, lng}'] });
    }
    return { lat: v.lat, lng: v.lng };
  };
  return {
    orderId: String(body.orderId),
    legId: String(body.legId),
    service: String(body.service),
    pickup: pt(body.pickup, 'pickup'),
    dropoff: pt(body.dropoff, 'dropoff'),
    earningsPesewas: BigInt(body.earningsPesewas ?? '0'),
    isCod: body.isCod === true,
    orderTotalPesewas: BigInt(body.orderTotalPesewas ?? '0'),
    ...(body.weightKg !== undefined ? { weightKg: Number(body.weightKg) } : {}),
    ...(body.fragile !== undefined ? { fragile: body.fragile === true } : {}),
  };
}

/* ------------------------------------------------------------------ */

@Controller('dispatch')
export class DispatchController {
  constructor(
    @Inject(DISPATCH_SERVICE) private readonly dispatch: DispatchService,
    @Inject(RIDER_SOURCE) private readonly riders: RiderSource,
    @Inject(VERIFY_TOKEN) private readonly verify: VerifyToken,
  ) {}

  private claims(auth?: string): Claims {
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedError();
    try { return this.verify(auth.slice(7)); }
    catch { throw new UnauthorizedError('Invalid token'); }
  }

  private rider(auth?: string): Claims {
    const c = this.claims(auth);
    if (c.role !== 'rider') throw new ForbiddenError('Riders only');
    return c;
  }

  /**
   * Broadcast one round of offers. Called by order-svc, not by a phone.
   *
   * Idempotent per (leg, round): re-broadcasting an already-assigned leg is a
   * 409 rather than a second set of offers, because the usual cause is a
   * retried message and double-assigning an order is unrecoverable.
   */
  @Post('broadcast')
  async broadcast(@Body() body: any) {
    const req = parseRequest(body);
    const round = Number(body.round ?? 1);
    const cfg = DISPATCH_ROUNDS.find((r) => r.round === round);
    if (!cfg) throw new ValidationError({ round: [`must be 1..${DISPATCH_ROUNDS.length}`] });

    const pool = await this.riders.candidates(req.pickup, cfg.radiusMetres);
    const offer = await this.dispatch.broadcast(req, pool, round);

    return {
      legId: offer.legId,
      orderId: offer.orderId,
      round: offer.round,
      riderIds: offer.riderIds,
      expiresAtMs: offer.expiresAtMs,
      radiusMetres: cfg.radiusMetres,
      // Empty is a legitimate answer, not an error — the caller escalates.
      candidatesConsidered: pool.length,
    };
  }

  /**
   * A rider taps Accept. The single most contended endpoint in the platform.
   *
   * Always 200 with an outcome, never a 409: losing a race is a normal event
   * in the rider's day and the app renders a friendly message from `reason`.
   */
  @Post('legs/:legId/accept')
  async accept(@Param('legId') legId: string, @Headers('authorization') auth?: string) {
    const c = this.rider(auth);
    const outcome = await this.dispatch.accept(legId, c.sub);
    return {
      won: outcome.won,
      reason: outcome.reason,
      legId,
      ...(outcome.won ? {} : { message: reasonMessage(outcome.reason) }),
    };
  }

  /** Rider declines. Recorded so the ranking can learn from it. */
  @Post('legs/:legId/decline')
  async decline(@Param('legId') legId: string, @Headers('authorization') auth?: string) {
    this.rider(auth);
    return { legId, declined: true };
  }

  /** Who owns this leg? Used by order-svc and by the rider app on reconnect. */
  @Get('legs/:legId/winner')
  async winner(@Param('legId') legId: string) {
    const riderId = await this.dispatch.currentWinner(legId);
    if (!riderId) throw new NotFoundError('Assignment');
    return { legId, riderId };
  }

  /**
   * Release an assignment (rider cancelled after accepting) so the leg can be
   * re-dispatched. Deliberately server-to-server: a rider must not be able to
   * silently drop a job they already collected food for.
   */
  @Post('legs/:legId/release')
  async release(@Param('legId') legId: string, @Headers('authorization') auth?: string) {
    const c = this.claims(auth);
    if (!['admin', 'service'].includes(c.role)) {
      throw new ForbiddenError('Only the platform can release an assignment');
    }
    await this.dispatch.releaseClaim(legId);
    return { legId, released: true };
  }

  /** The rider app pushes its position while online. */
  @Post('riders/position')
  async position(@Body() body: any, @Headers('authorization') auth?: string) {
    const c = this.rider(auth);
    requireFields(body, ['lat', 'lng']);
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new ValidationError({ lat: ['lat and lng must be numbers'] });
    }
    await this.dispatch.updatePosition(c.sub, { lat, lng });
    return { accepted: true };
  }

  /**
   * Dry run: would this rider be offered this job, and if not, why?
   *
   * Exists because "why am I not getting orders?" is the number one rider
   * support ticket, and support needs an answer that is not a guess.
   */
  @Post('eligibility')
  async eligibility(@Body() body: any) {
    const req = parseRequest(body);
    requireFields(body, ['rider']);
    const r = body.rider;
    const candidate: RiderCandidate = {
      riderId: String(r.riderId ?? 'probe'),
      position: { lat: Number(r.lat), lng: Number(r.lng) },
      vehicle: r.vehicle as VehicleType,
      isOnline: r.isOnline !== false,
      hasActiveLeg: r.hasActiveLeg === true,
      codObligationPesewas: BigInt(r.codObligationPesewas ?? '0'),
      acceptanceRate: Number(r.acceptanceRate ?? 1),
      cancellationsToday: Number(r.cancellationsToday ?? 0),
    };
    if (!VEHICLE_CAPABILITY[candidate.vehicle]) {
      throw new ValidationError({ vehicle: ['must be bicycle, motorbike or car'] });
    }
    const result = isEligible(candidate, req);
    return { eligible: result.eligible, ...(result.reason ? { reason: result.reason } : {}) };
  }

  /** What should the caller do now that a round expired with no takers? */
  @Get('escalation')
  escalation(@Query() q: any) {
    const elapsed = Number(q.elapsedSeconds);
    const lastRound = Number(q.lastRound);
    if (!Number.isFinite(elapsed) || !Number.isFinite(lastRound)) {
      throw new ValidationError({
        elapsedSeconds: ['elapsedSeconds and lastRound are required numbers'],
      });
    }
    return nextAction(elapsed, lastRound);
  }

  /** The live rate card for rounds — the apps render countdowns from this. */
  @Get('config')
  config() {
    return { rounds: DISPATCH_ROUNDS, vehicleCapability: VEHICLE_CAPABILITY };
  }
}

function reasonMessage(reason?: string): string {
  return switchReason(reason);
}

function switchReason(reason?: string): string {
  switch (reason) {
    case 'taken':
      return 'Another rider took this one. Stay online — the next is coming.';
    case 'expired':
      return 'This offer expired.';
    case 'not_offered':
      return 'This job was not offered to you.';
    default:
      return 'Could not accept this job.';
  }
}

/* ------------------------------------------------------------------ */

export interface DispatchDeps {
  pool?: Pool | null;
  claims?: ClaimStore;
  riderSource?: RiderSource;
  verifyToken?: VerifyToken;
  clock?: () => number;
}

@Module({})
export class DispatchHttpModule {
  static forRoot(deps: DispatchDeps = {}): DynamicModule {
    const pool = deps.pool ?? null;
    const claims = deps.claims ?? new InMemoryClaimStore(deps.clock);
    const riders = deps.riderSource
      ?? (pool ? new PgRiderSource(pool) : new InMemoryRiderSource());
    const service = new DispatchService(claims, deps.clock);
    const verify: VerifyToken = deps.verifyToken ?? (() => {
      throw new UnauthorizedError('token verification is not configured');
    });

    return {
      module: DispatchHttpModule,
      imports: [HealthModule.forRoot(pool)],
      controllers: [DispatchController],
      providers: [
        { provide: DISPATCH_SERVICE, useValue: service },
        { provide: RIDER_SOURCE, useValue: riders },
        { provide: VERIFY_TOKEN, useValue: verify },
      ],
    };
  }
}
