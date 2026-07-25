/**
 * vendor-bff HTTP surface.
 *
 * The wire shape is dictated by `VendorOrder.fromJson` in
 * `order_queue_controller.dart`. Note what it does NOT take: a preformatted
 * countdown. The app computes the accept deadline from the server's
 * `placedAt`, so a phone with a wrong clock cannot give a vendor a fake
 * three minutes — and the countdown keeps ticking between polls instead of
 * freezing on a stale number.
 */

import 'reflect-metadata';
import {
  Module, Controller, Get, Post, Patch, Body, Param, Headers,
  Inject, type DynamicModule,
} from '@nestjs/common';

import { HealthModule } from '../../../libs/platform/src/service/bootstrap.ts';
import {
  ValidationError, UnauthorizedError, ForbiddenError, NotFoundError,
} from '../../../libs/platform/src/errors.ts';
import {
  ServiceClient, settleWithFallback,
} from '../../../libs/platform/src/http/service-client.ts';

export const UPSTREAMS = Symbol('VENDOR_UPSTREAMS');
export const VERIFY_TOKEN = Symbol('VENDOR_VERIFY_TOKEN');

export interface Claims { sub: string; role: string; vendorId?: string }
export type VerifyToken = (token: string) => Claims;

export interface VendorUpstreams {
  order: ServiceClient;
  catalogue: ServiceClient;
  payment: ServiceClient;
}

/** The order events a vendor is allowed to raise, and their paths. */
const VENDOR_EVENTS: Record<string, string> = {
  accept: 'vendor_accept',
  reject: 'vendor_reject',
  preparing: 'vendor_start_preparing',
  ready: 'vendor_ready',
};

const ACTIVE_STATES = [
  'placed', 'prescription_review', 'vendor_accepted', 'preparing',
  'ready_for_pickup', 'rider_assigned', 'rider_at_vendor',
  'vendor_received', 'processing', 'vendor_done',
];

function bearer(auth?: string): string {
  if (!auth?.startsWith('Bearer ')) throw new UnauthorizedError();
  return auth.slice(7);
}

@Controller('api/vendor')
export class VendorBffController {
  constructor(
    @Inject(UPSTREAMS) private readonly up: VendorUpstreams,
    @Inject(VERIFY_TOKEN) private readonly verify: VerifyToken,
  ) {}

  private claims(auth?: string): Claims {
    const token = bearer(auth);
    let c: Claims;
    try { c = this.verify(token); }
    catch { throw new UnauthorizedError('Invalid token'); }
    if (!['vendor_owner', 'vendor_staff'].includes(c.role)) {
      throw new ForbiddenError('Vendors only');
    }
    if (!c.vendorId) {
      // A vendor account with no store attached cannot be served; failing
      // clearly beats returning an empty queue that looks like "no orders".
      throw new ForbiddenError('No store is linked to this account');
    }
    return c;
  }

  /**
   * The order queue. Polled every 10s by the app.
   *
   * Emits raw pesewas and an ISO `placedAt` because the Dart model owns the
   * formatting and the countdown.
   */
  @Get('queue')
  async queue(@Headers('authorization') auth?: string) {
    const c = this.claims(auth);
    const token = bearer(auth);
    const storeId = c.vendorId!;
    const opts = { bearerToken: token };

    const { values } = await settleWithFallback({
      store: {
        run: () => this.up.catalogue.get(`/catalogue/stores/${storeId}`, opts)
          .then((r) => r.store),
        fallback: null as any,
      },
      orders: {
        run: () => this.up.order.get(
          `/orders?storeId=${encodeURIComponent(storeId)}&states=${ACTIVE_STATES.join(',')}`,
          opts,
        ).then((r) => r.orders ?? []),
        fallback: [] as any[],
      },
    });

    return {
      storeName: values.store?.name ?? 'Your store',
      rating: values.store?.averageRating ?? values.store?.rating ?? 0,
      isOpen: values.store?.isOpen ?? true,
      orders: (values.orders as any[]).map(vendorOrder),
    };
  }

  /**
   * One endpoint per action rather than a generic `{event}` body.
   *
   * A vendor must never be able to drive an arbitrary transition; the map
   * above is the entire vocabulary they have.
   */
  @Post('orders/:id/:action')
  async act(
    @Param('id') orderId: string,
    @Param('action') action: string,
    @Body() body: any,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const c = this.claims(auth);
    const token = bearer(auth);

    const event = VENDOR_EVENTS[action];
    if (!event) {
      throw new ValidationError({
        action: [`must be one of ${Object.keys(VENDOR_EVENTS).join(', ')}`],
      });
    }
    if (action === 'reject' && !body?.reason) {
      // A rejection with no reason is invisible in the vendor quality report,
      // and the customer gets no explanation.
      throw new ValidationError({ reason: ['Tell the customer why'] });
    }

    await this.assertOwnStore(orderId, c.vendorId!, token);

    const res = await this.up.order.post(
      `/orders/${orderId}/events`,
      { event, ...(body?.reason ? { reason: body.reason } : {}) },
      {
        bearerToken: token,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
    );
    return { orderId, action, state: res.to ?? res.state };
  }

  @Patch('store/open')
  async setOpen(@Body() body: any, @Headers('authorization') auth?: string) {
    const c = this.claims(auth);
    const token = bearer(auth);
    const isOpen = body?.isOpen === null || body?.isOpen === undefined
      ? null
      : body.isOpen === true;

    await this.up.catalogue.patch(
      `/catalogue/manage/stores/${c.vendorId}/open`, { isOpen }, { bearerToken: token },
    );
    return { isOpen };
  }

  @Get('orders/:id')
  async detail(@Param('id') orderId: string, @Headers('authorization') auth?: string) {
    const c = this.claims(auth);
    const token = bearer(auth);
    const order = await this.assertOwnStore(orderId, c.vendorId!, token);
    return vendorOrder(order);
  }

  /**
   * The vendor's own menu, INCLUDING items they have switched off.
   *
   * The public store page hides unavailable items; this one must not, or a
   * vendor could never switch the tilapia back on after it sold out.
   */
  @Get('menu')
  async menu(@Headers('authorization') auth?: string) {
    const c = this.claims(auth);
    const token = bearer(auth);
    const r = await this.up.catalogue.get(
      `/catalogue/manage/stores/${c.vendorId}/items`, { bearerToken: token },
    );
    return {
      items: (r.items ?? []).map((i: any) => ({
        id: i.id,
        name: i.name,
        description: i.description ?? null,
        // Pesewa strings on the wire; the app formats them.
        basePricePesewas: i.basePricePesewas,
        isAvailable: i.isAvailable,
        requiresPrescription: i.requiresPrescription,
      })),
    };
  }

  /**
   * "We've run out of tilapia."
   *
   * By far the most-used vendor action, and the one with the shortest
   * fuse: every minute an unavailable item stays on the menu is another
   * order the kitchen will have to reject.
   */
  @Patch('menu/:itemId/availability')
  async setAvailability(
    @Param('itemId') itemId: string,
    @Body() body: any,
    @Headers('authorization') auth?: string,
  ) {
    this.claims(auth);
    const token = bearer(auth);
    if (typeof body?.isAvailable !== 'boolean') {
      throw new ValidationError({ isAvailable: ['must be true or false'] });
    }
    // catalogue-svc re-checks ownership from the token, so a vendor cannot
    // switch off a competitor's bestseller by guessing an item id.
    const r = await this.up.catalogue.patch(
      `/catalogue/manage/items/${itemId}/availability`,
      { isAvailable: body.isAvailable },
      { bearerToken: token },
    );
    return { id: r.id, name: r.name, isAvailable: r.isAvailable };
  }

  /** Add a dish. */
  @Post('menu')
  async addItem(@Body() body: any, @Headers('authorization') auth?: string) {
    const c = this.claims(auth);
    const token = bearer(auth);
    if (!body?.name) throw new ValidationError({ name: ['is required'] });
    if (body?.basePricePesewas === undefined) {
      throw new ValidationError({ basePricePesewas: ['is required'] });
    }
    return this.up.catalogue.post(
      `/catalogue/manage/stores/${c.vendorId}/items`,
      {
        name: String(body.name),
        basePricePesewas: String(body.basePricePesewas),
        ...(body.description ? { description: String(body.description) } : {}),
      },
      { bearerToken: token },
    );
  }

  /** Today's takings and the wallet, for the earnings strip. */
  @Get('earnings')
  async earnings(@Headers('authorization') auth?: string) {
    this.claims(auth);
    const token = bearer(auth);
    const { values } = await settleWithFallback({
      wallet: {
        run: () => this.up.payment.get('/payments/wallet', { bearerToken: token }),
        fallback: { balanceDisplay: '—', withdrawableDisplay: '—' } as any,
      },
    });
    return values.wallet;
  }

  /**
   * Defence in depth. The order service already scopes by store, but a
   * vendor guessing an order id must never reach another store's kitchen
   * ticket — that leaks a competitor's volume and their customers.
   */
  private async assertOwnStore(orderId: string, storeId: string, token: string) {
    let order: any;
    try {
      order = await this.up.order.get(`/orders/${orderId}`, { bearerToken: token });
    } catch {
      throw new NotFoundError('Order');
    }
    const owner = order.storeId ?? order.store_id;
    if (owner !== storeId) throw new NotFoundError('Order');
    return order;
  }
}

/** Matches `VendorOrder.fromJson` exactly. */
function vendorOrder(o: any) {
  return {
    id: o.id,
    humanRef: o.humanRef ?? o.human_ref,
    state: o.state,
    lines: (o.lines ?? []).map((l: any) => ({
      name: l.name,
      quantity: l.quantity ?? 1,
      addonNames: l.addonNames ?? [],
      variantNames: l.variantNames ?? [],
      ...(l.note ? { note: l.note } : {}),
    })),
    itemTotalPesewas: String(o.itemTotalPesewas ?? o.item_total_pesewas ?? '0'),
    vendorAmountPesewas: String(o.vendorAmountPesewas ?? o.vendor_amount_pesewas ?? '0'),
    // ISO-8601 from the SERVER. The app derives the countdown from this, so
    // a vendor phone with a skewed clock cannot invent extra time.
    placedAt: o.placedAt ?? o.placed_at ?? o.createdAt ?? o.created_at,
    isCod: o.isCod ?? o.payment_intent === 'cod',
    requiresPrescription: o.requiresPrescription ?? false,
    ...(o.riderName ? { riderName: o.riderName } : {}),
    ...(o.customerNote ? { customerNote: o.customerNote } : {}),
  };
}

export interface VendorBffDeps {
  upstreams: VendorUpstreams;
  verifyToken?: VerifyToken;
}

@Module({})
export class VendorBffHttpModule {
  static forRoot(deps: VendorBffDeps): DynamicModule {
    return {
      module: VendorBffHttpModule,
      imports: [HealthModule.forRoot(null)],
      controllers: [VendorBffController],
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
