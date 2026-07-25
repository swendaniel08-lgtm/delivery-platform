/**
 * Customer BFF. MASTER_PLAN §3.1, PDF §19.
 *
 * Purpose: one network call per SCREEN, not per entity. On a 3G connection in
 * Accra, six sequential round trips to render a home screen is the difference
 * between a usable app and an abandoned one.
 *
 * The BFF owns composition and shaping. It holds no business rules — those
 * live in the domain services — and it never talks to another service's
 * database.
 */

import { formatCedis, type Pesewas } from '../../../libs/money/src/money.ts';
import { NotFoundError, UpstreamError } from '../../../libs/platform/src/errors.ts';

/* ------------------------------------------------------------------ */
/* Upstream ports                                                      */
/* ------------------------------------------------------------------ */

export interface StoreSummary {
  id: string;
  name: string;
  serviceType: string;
  imageUrl: string | null;
  rating: number;
  totalOrders: number;
  avgPrepMinutes: number;
  isOpen: boolean;
  opensAt?: string;
  lat: number;
  lng: number;
}

export interface ActiveOrderSummary {
  id: string;
  humanRef: string;
  state: string;
  service: string;
  storeName: string | null;
  totalPesewas: string;
  riderName?: string;
  etaMinutes?: number;
}

export interface CatalogueClient {
  nearbyStores(input: {
    lat: number; lng: number; serviceType?: string; limit: number;
  }): Promise<StoreSummary[]>;
  search(input: { q: string; lat: number; lng: number }): Promise<StoreSummary[]>;
}

export interface OrderClient {
  activeForCustomer(customerId: string): Promise<ActiveOrderSummary[]>;
}

export interface AddressClient {
  defaultAddress(customerId: string): Promise<{
    id: string; label: string; lat: number; lng: number;
    areaName: string | null; landmark: string | null;
  } | null>;
}

export interface PricingClient {
  quoteDelivery(input: { fromLat: number; fromLng: number; toLat: number; toLng: number }): Promise<Pesewas>;
}

/* ------------------------------------------------------------------ */
/* Home screen (PDF §10)                                               */
/* ------------------------------------------------------------------ */

export interface ServiceTile {
  key: string;
  label: string;
  enabled: boolean;
}

/** Launch scope: Food + Parcel live, the rest behind flags (MASTER_PLAN §4.3). */
export const SERVICE_TILES = (flags: Record<string, boolean>): ServiceTile[] => [
  { key: 'food',      label: 'Food',      enabled: flags.food ?? true },
  { key: 'groceries', label: 'Groceries', enabled: flags.groceries ?? false },
  { key: 'market',    label: 'Market',    enabled: flags.market ?? false },
  { key: 'shop',      label: 'Shop',      enabled: flags.shop ?? false },
  { key: 'pharmacy',  label: 'Pharmacy',  enabled: flags.pharmacy ?? false },
  { key: 'laundry',   label: 'Laundry',   enabled: flags.laundry ?? false },
  { key: 'parcel',    label: 'Parcel',    enabled: flags.parcel ?? true },
  { key: 'errand',    label: 'Errand',    enabled: flags.errand ?? false },
];

export interface HomeScreen {
  deliveringTo: {
    label: string; areaName: string | null; landmark: string | null;
    lat: number; lng: number;
  } | null;
  services: ServiceTile[];
  activeOrder: ActiveOrderSummary | null;
  popularNearYou: StoreCard[];
  topRated: StoreCard[];
  newOnBesonc: StoreCard[];
}

export interface StoreCard {
  id: string;
  name: string;
  imageUrl: string | null;
  rating: number;
  prepEstimate: string;      // "25-35 min"
  deliveryFee: string;       // "GHS 5.00"
  isOpen: boolean;
  opensAt?: string;
}

export interface BffOptions {
  featureFlags?: Record<string, boolean>;
  /** Cards per carousel. */
  carouselSize?: number;
}

export class CustomerBff {
  constructor(
    private readonly catalogue: CatalogueClient,
    private readonly orders: OrderClient,
    private readonly addresses: AddressClient,
    private readonly pricing: PricingClient,
    private readonly opts: BffOptions = {},
  ) {}

  /**
   * ONE call renders the entire home screen.
   *
   * Upstreams are fetched in parallel and degrade independently: if the
   * catalogue is slow the customer still sees their active order, which is
   * the thing they actually opened the app for.
   */
  async home(customerId: string): Promise<HomeScreen> {
    const size = this.opts.carouselSize ?? 10;

    const address = await this.addresses.defaultAddress(customerId).catch(() => null);

    const [activeOrders, stores] = await Promise.all([
      this.orders.activeForCustomer(customerId).catch(() => [] as ActiveOrderSummary[]),
      address
        ? this.catalogue.nearbyStores({ lat: address.lat, lng: address.lng, limit: 40 })
            .catch(() => [] as StoreSummary[])
        : Promise.resolve([] as StoreSummary[]),
    ]);

    const cards = address
      ? await this.decorate(stores, address)
      : [];

    return {
      deliveringTo: address
        ? {
            label: address.label, areaName: address.areaName,
            landmark: address.landmark, lat: address.lat, lng: address.lng,
          }
        : null,
      services: SERVICE_TILES(this.opts.featureFlags ?? {}),
      activeOrder: activeOrders[0] ?? null,
      popularNearYou: [...cards].sort((a, b) => b.rating - a.rating).slice(0, size),
      topRated: [...cards].filter((c) => c.rating >= 4.5).slice(0, size),
      newOnBesonc: cards.slice(0, size),
    };
  }

  /** Vendor list for one service, closed stores last (PDF §10). */
  async serviceListing(customerId: string, serviceType: string): Promise<StoreCard[]> {
    const address = await this.addresses.defaultAddress(customerId);
    if (!address) throw new NotFoundError('Delivery address');

    const stores = await this.catalogue.nearbyStores({
      lat: address.lat, lng: address.lng, serviceType, limit: 60,
    });
    const cards = await this.decorate(stores, address);
    // open first, then by rating — a closed 5-star vendor is useless right now
    return cards.sort((a, b) =>
      Number(b.isOpen) - Number(a.isOpen) || b.rating - a.rating);
  }

  async search(customerId: string, q: string): Promise<StoreCard[]> {
    if (q.trim().length < 2) return [];
    const address = await this.addresses.defaultAddress(customerId);
    if (!address) throw new NotFoundError('Delivery address');
    const stores = await this.catalogue.search({ q, lat: address.lat, lng: address.lng });
    return this.decorate(stores, address);
  }

  /**
   * Attach a delivery-fee estimate to each card.
   *
   * Fees are quoted in ONE batch pass rather than per card — this is exactly
   * where a naive implementation makes 40 Distance Matrix calls to render one
   * screen and blows the Maps budget (issue #8).
   */
  private async decorate(
    stores: StoreSummary[],
    address: { lat: number; lng: number },
  ): Promise<StoreCard[]> {
    const fees = await Promise.all(stores.map((s) =>
      this.pricing
        .quoteDelivery({ fromLat: s.lat, fromLng: s.lng, toLat: address.lat, toLng: address.lng })
        .catch(() => null),
    ));

    return stores.map((s, i) => {
      const fee = fees[i];
      return {
        id: s.id,
        name: s.name,
        imageUrl: s.imageUrl,
        rating: s.rating,
        prepEstimate: prepRange(s.avgPrepMinutes),
        deliveryFee: fee === null || fee === undefined ? '—' : formatCedis(fee),
        isOpen: s.isOpen,
        ...(s.opensAt ? { opensAt: s.opensAt } : {}),
      };
    });
  }
}

/**
 * "25-35 min" reads better than "30 min" and sets honest expectations.
 *
 * Deliberately PESSIMISTIC: the lower bound is never below the vendor's
 * actual average. Rounding down would mean beating our own estimate less
 * than half the time, and a late order annoys a customer far more than an
 * early one delights them.
 */
export function prepRange(avgMinutes: number): string {
  const lo = Math.max(5, Math.ceil(avgMinutes / 5) * 5);
  return `${lo}-${lo + 10} min`;
}
