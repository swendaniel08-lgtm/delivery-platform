/**
 * customer-bff HTTP surface.
 *
 * The contract here is owned by the Flutter app, not by the services behind
 * it: `HomeData.fromJson` in `home_screen.dart` is the specification, and
 * these routes exist to satisfy it in ONE round trip over Ghanaian mobile
 * data.
 *
 * Every upstream is optional. If the catalogue is down the customer still
 * sees their active order — which is usually why they opened the app.
 */

import 'reflect-metadata';
import {
  Module, Controller, Get, Post, Body, Param, Query, Headers, Req,
  Inject, type DynamicModule,
} from '@nestjs/common';

import { HealthModule } from '../../../libs/platform/src/service/bootstrap.ts';
import {
  ValidationError, UnauthorizedError, NotFoundError, isClientError,
} from '../../../libs/platform/src/errors.ts';
import {
  ServiceClient, settleWithFallback,
} from '../../../libs/platform/src/http/service-client.ts';
import { formatCedis } from '../../../libs/money/src/money.ts';
import {
  haversineMetres, fallbackRoadDistanceMetres,
} from '../../../libs/maps/src/geohash.ts';
import type { MapsClient } from '../../../libs/maps/src/maps-client.ts';
import { SERVICE_TILES, prepRange } from './bff.ts';

export const UPSTREAMS = Symbol('CUSTOMER_UPSTREAMS');
export const VERIFY_TOKEN = Symbol('CUSTOMER_VERIFY_TOKEN');
export const FEATURE_FLAGS = Symbol('CUSTOMER_FEATURE_FLAGS');
export const MAPS = Symbol('CUSTOMER_MAPS');

export interface Claims { sub: string; role: string }
export type VerifyToken = (token: string) => Claims;

export interface CustomerUpstreams {
  identity: ServiceClient;
  catalogue: ServiceClient;
  order: ServiceClient;
  pricing: ServiceClient;
  tracking: ServiceClient;
  payment: ServiceClient;
  messaging: ServiceClient;
}

function requireFields(body: any, fields: string[]): void {
  const errors: Record<string, string[]> = {};
  for (const f of fields) {
    if (body?.[f] === undefined || body[f] === null || body[f] === '') {
      errors[f] = ['is required'];
    }
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
}

function bearer(auth?: string): string {
  if (!auth?.startsWith('Bearer ')) throw new UnauthorizedError();
  return auth.slice(7);
}

/* ------------------------------------------------------------------ */

@Controller('api/customer')
export class CustomerBffController {
  constructor(
    @Inject(UPSTREAMS) private readonly up: CustomerUpstreams,
    @Inject(VERIFY_TOKEN) private readonly verify: VerifyToken,
    @Inject(FEATURE_FLAGS) private readonly flags: Record<string, boolean>,
    @Inject(MAPS) private readonly maps: MapsClient | null,
  ) {}

  /**
   * Road distance between two points.
   *
   * Google when a key is configured, straight-line x1.4 otherwise. The
   * fallback matters: a Maps outage must make the fee slightly wrong, never
   * make checkout impossible. 1.4 is the usual winding factor for Accra's
   * road grid and errs slightly HIGH, so an outage cannot accidentally
   * undercharge for delivery.
   */
  private async roadDistance(
    from: { lat: number; lng: number }, to: { lat: number; lng: number },
  ): Promise<{ metres: number; source: 'google' | 'estimate' }> {
    if (this.maps) {
      try {
        const route = await this.maps.route(from, to);
        return { metres: route.distanceMetres, source: 'google' };
      } catch {
        // Fall through. Logged by MapsClient; not worth failing an order.
      }
    }
    return {
      metres: Math.round(fallbackRoadDistanceMetres(from, to)),
      source: 'estimate',
    };
  }

  private claims(auth?: string): Claims {
    const token = bearer(auth);
    try { return this.verify(token); }
    catch { throw new UnauthorizedError('Invalid token'); }
  }

  /**
   * The entire home screen in one call.
   *
   * Shape is dictated by `HomeData.fromJson`. Changing a key here breaks
   * every installed app, so the customer-bff spec pins all of them.
   */
  @Get('home')
  async home(@Headers('authorization') auth?: string, @Req() req?: any) {
    const c = this.claims(auth);
    const token = bearer(auth);
    const correlationId = req?.correlationId;
    const opts = { bearerToken: token, correlationId };

    // The address decides everything else, so it is fetched first.
    let address: any = null;
    try {
      const res = await this.up.identity.get('/users/me/addresses', opts);
      address = (res.addresses ?? []).find((a: any) => a.isDefault)
        ?? res.addresses?.[0] ?? null;
    } catch {
      // No address is a legitimate state for a new user, and an identity
      // blip must not blank the whole screen.
    }

    const { values, degraded } = await settleWithFallback({
      activeOrders: {
        run: () => this.up.order
          .get(`/orders?customerId=${encodeURIComponent(c.sub)}&active=true`, opts)
          .then((r) => r.orders ?? []),
        fallback: [] as any[],
      },
      stores: {
        run: async () => {
          if (!address) return [];
          const r = await this.up.catalogue.get(
            `/catalogue/stores?lat=${address.latitude}&lng=${address.longitude}&limit=40`,
            opts,
          );
          return r.stores ?? [];
        },
        fallback: [] as any[],
      },
    });

    const cards = (values.stores as any[]).map((s) => storeCard(s));

    return {
      deliveringTo: address
        ? {
            label: address.label,
            areaName: address.areaName ?? null,
            landmark: address.landmark ?? null,
            lat: address.latitude,
            lng: address.longitude,
          }
        : null,
      services: SERVICE_TILES(this.flags),
      activeOrder: (values.activeOrders as any[])[0]
        ? activeOrder((values.activeOrders as any[])[0])
        : null,
      popularNearYou: [...cards].sort((a, b) => b.rating - a.rating).slice(0, 10),
      topRated: cards.filter((c2) => c2.rating >= 4.5).slice(0, 10),
      newOnBesonc: cards.slice(0, 10),
      // Surfaced so the app can show "some results may be missing" rather
      // than pretending an empty carousel means no vendors exist.
      ...(degraded.length ? { degraded } : {}),
    };
  }

  /** Vendor list for one service tile. */
  @Get('services/:key/stores')
  async serviceListing(
    @Param('key') key: string, @Query() q: any, @Headers('authorization') auth?: string,
  ) {
    this.claims(auth);
    const token = bearer(auth);
    const { lat, lng } = await this.requireLocation(q, token);

    const r = await this.up.catalogue.get(
      `/catalogue/stores?lat=${lat}&lng=${lng}&service=${encodeURIComponent(key)}&limit=60`,
      { bearerToken: token },
    );
    const cards = (r.stores ?? []).map((s: any) => storeCard(s));
    // Open first, then by rating: a closed 5-star vendor is useless now.
    cards.sort((a: any, b: any) =>
      Number(b.isOpen) - Number(a.isOpen) || b.rating - a.rating);
    return { service: key, stores: cards };
  }

  @Get('search')
  async search(@Query() q: any, @Headers('authorization') auth?: string) {
    this.claims(auth);
    const token = bearer(auth);
    const term = String(q.q ?? '').trim();
    if (term.length < 2) return { query: term, items: [] };

    const r = await this.up.catalogue.get(
      `/catalogue/search?q=${encodeURIComponent(term)}`, { bearerToken: token },
    );
    return {
      query: term,
      items: (r.items ?? []).map((i: any) => ({
        id: i.id,
        name: i.name,
        storeId: i.storeId,
        storeName: i.storeName,
        priceDisplay: formatCedis(BigInt(i.basePricePesewas ?? '0')),
        basePricePesewas: i.basePricePesewas,
      })),
    };
  }

  /** The store page: details plus the full menu, in one call. */
  @Get('stores/:id')
  async store(@Param('id') id: string, @Headers('authorization') auth?: string) {
    this.claims(auth);
    const token = bearer(auth);
    const r = await this.up.catalogue.get(`/catalogue/stores/${id}`, { bearerToken: token });
    return {
      store: storeCard(r.store),
      categories: [
        // The catalogue returns a flat menu; the app renders categories.
        // One unnamed group is honest until categories are modelled.
        { name: 'Menu', items: (r.items ?? []).map((i: any) => menuItem(i)) },
      ],
    };
  }

  /** Where is my order? Proxied so the app has one base URL. */
  @Get('orders/:id/tracking')
  async tracking(@Param('id') id: string, @Headers('authorization') auth?: string) {
    this.claims(auth);
    const token = bearer(auth);
    try {
      return await this.up.tracking.get(`/tracking/orders/${id}/position`,
        { bearerToken: token });
    } catch {
      // Tracking being down must not look like a lost order.
      return { orderId: id, riderAssigned: false, position: null, degraded: true };
    }
  }


  /**
   * Price a cart before the customer commits.
   *
   * The APP NEVER ADDS ANYTHING UP. It sends what is in the cart and renders
   * whatever comes back, so the number on the button is by construction the
   * number the ledger will settle. A client that computes its own total
   * eventually disagrees with the server, and the server is right.
   */
  @Post('checkout/quote')
  async quote(@Body() body: any, @Headers('authorization') auth?: string) {
    const c = this.claims(auth);
    const token = bearer(auth);
    requireFields(body, ['storeId', 'lines']);

    // Re-price every line from the CATALOGUE, not from prices the client
    // sent. Otherwise a modified app pays whatever it likes.
    const store = await this.up.catalogue.get(
      `/catalogue/stores/${body.storeId}`, { bearerToken: token },
    );
    const itemsById = new Map<string, any>(
      (store.items ?? []).map((i: any) => [i.id, i]),
    );

    let itemTotal = 0n;
    for (const line of body.lines as any[]) {
      const item = itemsById.get(line.itemId);
      if (!item) {
        throw new ValidationError({
          lines: [`"${line.itemId}" is no longer on the menu`],
        });
      }
      const priced = await this.up.catalogue.post(
        `/catalogue/items/${line.itemId}/price`,
        {
          addonItemIds: line.addonOptionIds ?? [],
          variantOptionIds: line.variantOptionIds ?? [],
          quantity: line.quantity ?? 1,
        },
        { bearerToken: token },
      );
      itemTotal += BigInt(priced.linePesewas);
    }

    const address = await this.defaultAddress(token);
    if (!address) {
      throw new ValidationError({ addressId: ['Add a delivery address first'] });
    }

    const distance = await this.roadDistance(
      { lat: store.store.latitude, lng: store.store.longitude },
      { lat: address.latitude, lng: address.longitude },
    );
    const distanceMetres = distance.metres;

    const quote = await this.up.pricing.post('/pricing/quote', {
      service: store.store.serviceType ?? 'food',
      itemTotalPesewas: itemTotal.toString(),
      distanceMetres: Math.round(distanceMetres),
    }, { bearerToken: token });

    // COD eligibility is a SERVER decision (PDF §7): order size, customer
    // history, rider float and the 9pm cutoff. The app only renders it.
    const cod = await this.up.pricing.post('/pricing/cod/eligible', {
      orderTotalPesewas: quote.totalPesewas,
      service: store.store.serviceType ?? 'food',
      customerCompletedOrders: 0,
    }, { bearerToken: token }).catch(() => ({ eligible: false, reason: undefined }));

    return {
      itemTotalPesewas: quote.itemTotalPesewas,
      deliveryFeePesewas: quote.deliveryFeePesewas,
      serviceFeePesewas: quote.serviceFeePesewas,
      totalPesewas: quote.totalPesewas,
      codEligible: cod.eligible === true,
      ...(cod.reason ? { codReason: cod.reason } : {}),
      distanceMetres: Math.round(distanceMetres),
      // Surfaced so support can tell a disputed fee computed from a real
      // route apart from one estimated during a Maps outage.
      distanceSource: distance.source,
    };
  }

  /**
   * Place the order.
   *
   * Idempotent on the client's key: a timeout on a Ghanaian mobile network
   * is routine, and a retry must never produce a second order the customer
   * pays for twice.
   */
  @Post('checkout')
  async checkout(
    @Body() body: any,
    @Headers('authorization') auth?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const c = this.claims(auth);
    const token = bearer(auth);
    requireFields(body, ['storeId', 'lines', 'paymentIntent']);

    if (!idempotencyKey) {
      throw new ValidationError({
        'idempotency-key': ['header is required so a retry cannot double-order'],
      });
    }

    // Re-quote server-side. The client's displayed total is advisory; this
    // is the figure the order is actually created with.
    const quote = await this.quote(body, auth);

    if (body.paymentIntent === 'cod' && !quote.codEligible) {
      throw new ValidationError({
        paymentIntent: [quote.codReason ?? 'Cash is not available for this order'],
      });
    }

    const address = await this.defaultAddress(token);
    const store = await this.up.catalogue.get(
      `/catalogue/stores/${body.storeId}`, { bearerToken: token },
    );

    const order = await this.up.order.post('/orders', {
      customerId: c.sub,
      storeId: body.storeId,
      service: store.store.serviceType ?? 'food',
      itemTotalPesewas: quote.itemTotalPesewas,
      deliveryFeePesewas: quote.deliveryFeePesewas,
      serviceFeePesewas: quote.serviceFeePesewas,
      paymentIntent: body.paymentIntent,
      legs: [{
        sequence: 1,
        legType: 'vendor_to_customer',
        pickup: { lat: store.store.latitude, lng: store.store.longitude },
        dropoff: { lat: address!.latitude, lng: address!.longitude },
        feePesewas: quote.deliveryFeePesewas,
      }],
    }, { bearerToken: token, idempotencyKey });

    // Kick off the mobile-money charge. Deliberately AFTER the order
    // exists: a charge with no order to attach it to is a refund waiting
    // to happen, whereas an order with no charge is simply unpaid and
    // expires on its own timer.
    let charge: Record<string, unknown> | null = null;
    if (body.paymentIntent === 'prepaid' && body.momoPhone) {
      try {
        charge = await this.up.payment.post('/payments/internal/charges/momo', {
          orderId: order.id,
          amountPesewas: quote.totalPesewas,
          phone: String(body.momoPhone),
          // Paystack requires an email. Customers sign up with a phone, so
          // a deterministic per-order address keeps their receipts
          // separable without inventing a mailbox they do not own.
          email: body.email ?? `${c.sub}@customers.besonc.app`,
          attempt: 1,
        }, { bearerToken: token });
      } catch (e) {
        // The order stands. The app shows the failure and offers a retry
        // rather than losing a cart the customer already assembled.
        charge = { failed: true, reason: (e as Error).message };
      }
    }

    return {
      orderId: order.id,
      humanRef: order.humanRef,
      state: order.state,
      totalPesewas: order.totalPesewas,
      // Mobile money needs the customer to approve a prompt, so the app
      // must WAIT rather than show a success screen on this response.
      requiresApproval: body.paymentIntent === 'prepaid',
      ...(charge ? { charge } : {}),
    };
  }

  private async defaultAddress(token: string) {
    const res = await this.up.identity.get('/users/me/addresses',
      { bearerToken: token });
    return (res.addresses ?? []).find((a: any) => a.isDefault)
      ?? res.addresses?.[0] ?? null;
  }

  private async requireLocation(q: any, token: string) {
    if (q.lat !== undefined && q.lng !== undefined) {
      return { lat: Number(q.lat), lng: Number(q.lng) };
    }
    const res = await this.up.identity.get('/users/me/addresses', { bearerToken: token });
    const addr = (res.addresses ?? []).find((a: any) => a.isDefault) ?? res.addresses?.[0];
    if (!addr) {
      throw new ValidationError({ lat: ['Add a delivery address first'] });
    }
    return { lat: addr.latitude, lng: addr.longitude };
  }
  /* ---------------- chat ---------------- */

  /**
   * The conversation for an order.
   *
   * A conversation nobody has started yet is EMPTY, not missing — the screen
   * opens on a blank thread, which is the normal case, rather than an error
   * banner.
   */
  @Get('orders/:id/chat')
  async chatHistory(@Param('id') id: string, @Headers('authorization') auth?: string) {
    this.claims(auth);
    const token = bearer(auth);
    try {
      return await this.up.messaging.get(`/messaging/chat/${id}`, { bearerToken: token });
    } catch (err) {
      // A 403 is the closed 30-minute window and MUST reach the app, which
      // renders it as "this conversation has closed". Only an outage is
      // degraded here.
      if (isClientError(err)) throw err;
      return { orderId: id, messages: [], degraded: true };
    }
  }

  /**
   * Send a message.
   *
   * Never degraded: silently swallowing a send would show the customer their
   * own message in the thread while the rider never receives it, which is
   * worse than a visible failure they can retry.
   */
  @Post('orders/:id/chat')
  async chatSend(
    @Param('id') id: string, @Body() body: any,
    @Headers('authorization') auth?: string,
  ) {
    this.claims(auth);
    const token = bearer(auth);
    return this.up.messaging.post(`/messaging/chat/${id}`, body ?? {}, {
      bearerToken: token,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Wire shapes — these MUST match the Dart models                      */
/* ------------------------------------------------------------------ */

/** Matches `StoreCard.fromJson` in besonc_models. */
function storeCard(s: any) {
  return {
    id: s.id,
    name: s.name,
    imageUrl: s.imageUrl ?? null,
    rating: s.averageRating ?? s.rating ?? 0,
    prepEstimate: s.prepLabel ?? prepRange(s.averagePrepMinutes ?? 20),
    // The app renders this string directly; '—' is honest when pricing is
    // unavailable, and far better than a fabricated fee.
    deliveryFee: s.deliveryFeeDisplay ?? '—',
    isOpen: s.isOpen ?? false,
    ...(s.opensAt ? { opensAt: s.opensAt } : {}),
    ...(s.distanceMetres !== undefined ? { distanceMetres: s.distanceMetres } : {}),
  };
}

/** Matches `ActiveOrder.fromJson`. */
function activeOrder(o: any) {
  return {
    id: o.id,
    humanRef: o.humanRef ?? o.human_ref,
    state: o.state,
    service: o.service,
    totalPesewas: String(o.totalPesewas ?? o.total_pesewas ?? '0'),
    storeName: o.storeName ?? null,
    riderName: o.riderName ?? null,
    ...(o.etaMinutes !== undefined ? { etaMinutes: o.etaMinutes } : {}),
    // The map needs a destination. Without it the tracking screen can show a
    // rider moving and no indication of where they are moving TO, which is
    // the one thing the customer is actually asking.
    ...(latLng(o.dropoff ?? o.deliveryAddress) ? { dropoff: latLng(o.dropoff ?? o.deliveryAddress) } : {}),
    ...(latLng(o.pickup ?? o.storePosition) ? { pickup: latLng(o.pickup ?? o.storePosition) } : {}),
  };
}

/** Normalises the several shapes upstreams use for a coordinate pair. */
function latLng(v: any): { lat: number; lng: number } | null {
  if (!v) return null;
  const lat = Number(v.lat ?? v.latitude);
  const lng = Number(v.lng ?? v.longitude);
  // A missing pin must be omitted, not sent as (0,0) — null island is in the
  // Atlantic and would draw an Accra delivery 600km out to sea.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

/** Matches `MenuItem.fromJson` in vendor_screen.dart. */
function menuItem(i: any) {
  return {
    id: i.id,
    name: i.name,
    description: i.description ?? null,
    basePricePesewas: i.basePricePesewas,
    // The Dart model reads `available`, not `isAvailable`.
    available: i.isAvailable ?? true,
    imageUrl: i.imageUrl ?? null,
    addonGroups: (i.addonGroups ?? []).map((g: any) => ({
      id: g.id,
      name: g.name,
      // The Dart model reads `required`, not `isRequired`.
      required: g.isRequired ?? false,
      minSelections: g.minSelections,
      maxSelections: g.maxSelections,
      options: (g.items ?? []).map((a: any) => ({
        id: a.id,
        name: a.name,
        pricePesewas: a.pricePesewas,
        available: a.isAvailable,
      })),
    })),
  };

}

/* ------------------------------------------------------------------ */

export interface CustomerBffDeps {
  upstreams: CustomerUpstreams;
  verifyToken?: VerifyToken;
  featureFlags?: Record<string, boolean>;
  /** Null falls back to a straight-line estimate. */
  maps?: MapsClient | null;
}

@Module({})
export class CustomerBffHttpModule {
  static forRoot(deps: CustomerBffDeps): DynamicModule {
    return {
      module: CustomerBffHttpModule,
      imports: [HealthModule.forRoot(null)],
      controllers: [CustomerBffController],
      providers: [
        { provide: UPSTREAMS, useValue: deps.upstreams },
        {
          provide: VERIFY_TOKEN,
          useValue: deps.verifyToken ?? (() => {
            throw new UnauthorizedError('token verification is not configured');
          }),
        },
        { provide: FEATURE_FLAGS, useValue: deps.featureFlags ?? {} },
        { provide: MAPS, useValue: deps.maps ?? null },
      ],
    };
  }
}
