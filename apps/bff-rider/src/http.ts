/**
 * rider-bff HTTP surface.
 *
 * Shape is dictated by `RiderCoordinator.refresh()` and `ActiveLeg.fromJson`.
 *
 * One rule shapes the whole file: **the exact dropoff address is withheld
 * until a rider has accepted** (PDF §4). An offer carries an area only. A
 * rider who could read full addresses from broadcast offers could farm
 * customer addresses without ever doing a delivery.
 */

import 'reflect-metadata';
import {
  Module, Controller, Get, Post, Body, Param, Headers,
  Inject, type DynamicModule,
} from '@nestjs/common';

import { HealthModule } from '../../../libs/platform/src/service/bootstrap.ts';
import {
  ValidationError, UnauthorizedError, ForbiddenError, NotFoundError,
} from '../../../libs/platform/src/errors.ts';
import {
  ServiceClient, settleWithFallback,
} from '../../../libs/platform/src/http/service-client.ts';

export const UPSTREAMS = Symbol('RIDER_UPSTREAMS');
export const VERIFY_TOKEN = Symbol('RIDER_VERIFY_TOKEN');

export interface Claims { sub: string; role: string }
export type VerifyToken = (token: string) => Claims;

export interface RiderUpstreams {
  order: ServiceClient;
  dispatch: ServiceClient;
  payment: ServiceClient;
  tracking: ServiceClient;
  identity: ServiceClient;
  media: ServiceClient;
}

/** Events a rider may raise. Anything else is not in their vocabulary. */
const RIDER_EVENTS = new Set([
  'rider_arrive_pickup', 'rider_pickup', 'rider_arrive', 'rider_deliver',
]);

function bearer(auth?: string): string {
  if (!auth?.startsWith('Bearer ')) throw new UnauthorizedError();
  return auth.slice(7);
}

@Controller('api/rider')
export class RiderBffController {
  constructor(
    @Inject(UPSTREAMS) private readonly up: RiderUpstreams,
    @Inject(VERIFY_TOKEN) private readonly verify: VerifyToken,
  ) {}

  private claims(auth?: string): Claims {
    const token = bearer(auth);
    let c: Claims;
    try { c = this.verify(token); }
    catch { throw new UnauthorizedError('Invalid token'); }
    if (c.role !== 'rider') throw new ForbiddenError('Riders only');
    return c;
  }

  /**
   * Everything the rider home screen needs, polled every 5s while online.
   *
   * Every upstream degrades to a safe default: a rider mid-delivery must
   * never lose their job card because the payment service hiccuped.
   */
  @Get('state')
  async state(@Headers('authorization') auth?: string) {
    const c = this.claims(auth);
    const token = bearer(auth);
    const opts = { bearerToken: token };

    const { values } = await settleWithFallback({
      profile: {
        run: () => this.up.identity.get('/users/me', opts),
        fallback: null as any,
      },
      leg: {
        run: () => this.up.order
          .get(`/legs/active?riderId=${encodeURIComponent(c.sub)}`, opts)
          .then((r) => r.leg ?? null),
        fallback: null as any,
      },
      offer: {
        run: () => this.up.dispatch
          .get(`/dispatch/riders/${encodeURIComponent(c.sub)}/offer`, opts)
          .then((r) => r.offer ?? null),
        fallback: null as any,
      },
      wallet: {
        run: () => this.up.payment.get('/payments/wallet', opts),
        fallback: null as any,
      },
      earnings: {
        run: () => this.up.payment
          .get(`/payments/earnings/today?riderId=${encodeURIComponent(c.sub)}`, opts),
        fallback: { earnedPesewas: '0', deliveries: 0 } as any,
      },
    });

    const profile = values.profile as any;
    const wallet = values.wallet as any;

    return {
      riderName: profile?.firstName ?? profile?.phone ?? '',
      // Default FALSE: an identity outage must not let an unapproved or
      // suspended rider start taking jobs.
      approved: profile?.status === 'active' && (profile?.riderApproved ?? true),
      walletBalancePesewas: String(wallet?.balancePesewas ?? '0'),
      todayEarningsPesewas: String((values.earnings as any)?.earnedPesewas ?? '0'),
      todayDeliveries: (values.earnings as any)?.deliveries ?? 0,
      codObligationPesewas: String(wallet?.codObligationPesewas ?? '0'),
      ...(wallet?.oldestUnremittedAt
        ? { oldestUnremittedAt: wallet.oldestUnremittedAt } : {}),
      activeLeg: values.leg ? activeLeg(values.leg as any) : null,
      offer: values.offer ? offerCard(values.offer as any) : null,
    };
  }

  @Post('online')
  async goOnline(@Headers('authorization') auth?: string) {
    return this.setOnline(auth, true);
  }

  @Post('offline')
  async goOffline(@Headers('authorization') auth?: string) {
    return this.setOnline(auth, false);
  }

  private async setOnline(auth: string | undefined, online: boolean) {
    const c = this.claims(auth);
    const token = bearer(auth);

    if (online) {
      // Check the cash ceiling BEFORE going online, so the rider gets a
      // real reason instead of silently receiving no offers all morning.
      const wallet = await this.up.payment.get('/payments/wallet', { bearerToken: token })
        .catch(() => null);
      const cod = BigInt((wallet as any)?.codObligationPesewas ?? '0');
      if (cod > 30_000n) {
        throw new ForbiddenError(
          'Remit your cash balance before going online — you are holding more than GHS 300',
        );
      }
    }

    await this.up.dispatch.post('/dispatch/riders/availability',
      { riderId: c.sub, online }, { bearerToken: token });
    return { isOnline: online };
  }

  /** Accept an offer. Losing the race is a 200, not an error. */
  @Post('legs/:legId/accept')
  async accept(
    @Param('legId') legId: string,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    this.claims(auth);
    const token = bearer(auth);
    const res = await this.up.dispatch.post(
      `/dispatch/legs/${legId}/accept`, {},
      { bearerToken: token, ...(idempotencyKey ? { idempotencyKey } : {}) },
    );
    return {
      won: res.won === true,
      reason: res.reason,
      ...(res.message ? { message: res.message } : {}),
    };
  }

  @Post('legs/:legId/decline')
  async decline(@Param('legId') legId: string, @Headers('authorization') auth?: string) {
    this.claims(auth);
    const token = bearer(auth);
    await this.up.dispatch.post(`/dispatch/legs/${legId}/decline`, {},
      { bearerToken: token }).catch(() => null);
    return { legId, declined: true };
  }

  /** Advance the leg. The event vocabulary is fixed and validated here. */
  @Post('legs/:legId/events')
  async event(
    @Param('legId') legId: string,
    @Body() body: any,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    this.claims(auth);
    const token = bearer(auth);
    const event = String(body?.event ?? '');

    if (!RIDER_EVENTS.has(event)) {
      throw new ValidationError({
        event: [`must be one of ${[...RIDER_EVENTS].join(', ')}`],
      });
    }
    // Proof is enforced server-side too, but refusing here saves a round
    // trip and gives the rider a message they can act on.
    if (event === 'rider_deliver' && !body?.photoUrl && body?.requiresProof !== false) {
      throw new ValidationError({ photoUrl: ['Take a photo of the delivery first'] });
    }

    const res = await this.up.order.post(
      `/legs/${legId}/events`,
      { event, ...(body?.photoUrl ? { photoUrl: body.photoUrl } : {}) },
      { bearerToken: token, ...(idempotencyKey ? { idempotencyKey } : {}) },
    );
    return { legId, event, state: res.to ?? res.state };
  }

  /**
   * Somewhere to put a proof-of-delivery photo.
   *
   * The rider app cannot complete a delivery without one — order-svc
   * rejects `rider_deliver` with no photoUrl — so this route is on the
   * critical path of every single delivery, not a nice-to-have.
   *
   * Bytes go straight from the handset to object storage. Proxying a 3MB
   * photo through here on Ghanaian mobile data would double the upload
   * time and burn our egress for no benefit.
   */
  @Post('proof-uploads')
  async proofUpload(@Body() body: any, @Headers('authorization') auth?: string) {
    this.claims(auth);
    const token = bearer(auth);
    if (!body?.orderId) throw new ValidationError({ orderId: ['is required'] });

    return this.up.media.post('/media/uploads', {
      kind: 'proof_of_delivery',
      contentType: body.contentType ?? 'image/jpeg',
      sizeBytes: Number(body.sizeBytes ?? 0),
      ownerRef: String(body.orderId),
    }, { bearerToken: token });
  }

  /** Rider pays in collected cash. */
  @Post('cod/remit')
  async remit(@Body() body: any, @Headers('authorization') auth?: string) {
    this.claims(auth);
    const token = bearer(auth);
    if (!body?.amountPesewas) {
      throw new ValidationError({ amountPesewas: ['is required'] });
    }
    return this.up.payment.post('/payments/cod/remittances', {
      amountPesewas: String(body.amountPesewas),
      remittanceId: body.remittanceId ?? `rem_${Date.now()}`,
    }, { bearerToken: token });
  }
}

/* ------------------------------------------------------------------ */
/* Wire shapes — must match the Dart models                            */
/* ------------------------------------------------------------------ */

/** Matches `ActiveLeg.fromJson`. Full address: the rider already accepted. */
function activeLeg(l: any) {
  return {
    legId: l.legId ?? l.id,
    orderId: l.orderId ?? l.order_id,
    humanRef: l.humanRef ?? l.human_ref,
    state: l.state,
    service: l.service ?? 'food',
    pickup: {
      lat: l.pickup?.lat, lng: l.pickup?.lng,
      label: l.pickup?.label ?? '',
    },
    dropoff: {
      lat: l.dropoff?.lat, lng: l.dropoff?.lng,
      label: l.dropoff?.label ?? '',
      ...(l.dropoff?.landmark ? { landmark: l.dropoff.landmark } : {}),
      ...(l.dropoff?.instructions ? { instructions: l.dropoff.instructions } : {}),
    },
    feePesewas: String(l.feePesewas ?? l.fee_pesewas ?? '0'),
    isCod: l.isCod ?? false,
    ...(l.codAmountPesewas ? { codAmountPesewas: String(l.codAmountPesewas) } : {}),
    ...(l.customerName ? { customerName: l.customerName } : {}),
  };
}

/**
 * Matches `DispatchOffer.fromJson`.
 *
 * Note the AREA, not the address: `dropoffArea` is all a rider sees before
 * accepting, and there are no coordinates here at all.
 */
function offerCard(o: any) {
  return {
    legId: o.legId,
    orderId: o.orderId,
    service: o.service ?? 'food',
    pickupLabel: o.pickupLabel ?? '',
    dropoffArea: o.dropoffArea ?? '',
    earningsPesewas: String(o.earningsPesewas ?? '0'),
    distanceMetres: o.distanceMetres ?? 0,
    expiresAt: o.expiresAt ?? new Date(o.expiresAtMs ?? Date.now()).toISOString(),
    isCod: o.isCod ?? false,
  };
}

export interface RiderBffDeps {
  upstreams: RiderUpstreams;
  verifyToken?: VerifyToken;
}

@Module({})
export class RiderBffHttpModule {
  static forRoot(deps: RiderBffDeps): DynamicModule {
    return {
      module: RiderBffHttpModule,
      imports: [HealthModule.forRoot(null)],
      controllers: [RiderBffController],
      providers: [
        { provide: UPSTREAMS, useValue: deps.upstreams },
        {
          provide: VERIFY_TOKEN,
          useValue: deps.verifyToken ?? (() => {
            throw new UnauthorizedError('token verification is not configured');
          }),
        },
      ],
    };
  }
}
