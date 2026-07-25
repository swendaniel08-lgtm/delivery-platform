/**
 * catalogue-svc domain.
 *
 * ONE template serves all six catalogue services (PDF §2). A pharmacy is a
 * store whose items may require a prescription; a laundry is a store whose
 * items are priced per item or per bag. Resisting the urge to write six
 * services is the single biggest simplification in the platform.
 *
 * search-svc is merged in here (MASTER_PLAN §1.3, issue #11) so the search
 * index is owned by the service that owns the data.
 */

import { ValidationError } from '../../../libs/platform/src/errors.ts';
import { haversineMetres, type LatLng } from '../../../libs/maps/src/geohash.ts';

export type ServiceType =
  | 'food' | 'groceries' | 'shop' | 'market' | 'pharmacy' | 'laundry';

export const SERVICE_TYPES: ServiceType[] = [
  'food', 'groceries', 'shop', 'market', 'pharmacy', 'laundry',
];

export type StoreStatus = 'pending_review' | 'approved' | 'suspended' | 'rejected';

/* ------------------------------------------------------------------ */
/* Opening hours                                                       */
/* ------------------------------------------------------------------ */

export interface DaySlot { open: string; close: string }
/** Keys are lowercase 3-letter day names, matching `store_is_open()` in SQL. */
export type OperatingHours = Partial<Record<
  'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', DaySlot | null
>>;

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * Ghana runs on UTC year-round (Africa/Accra, no DST), so "local time" is
 * just UTC. This is worth stating out loud because it is the reason we can
 * do the comparison arithmetically instead of dragging in a tz database.
 */
export function accraParts(at: Date): { day: string; minutes: number } {
  return {
    day: DAY_KEYS[at.getUTCDay()]!,
    minutes: at.getUTCHours() * 60 + at.getUTCMinutes(),
  };
}

function parseHHMM(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new ValidationError({ operatingHours: [`"${s}" is not HH:MM`] });
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) throw new ValidationError({ operatingHours: [`"${s}" is not a real time`] });
  return h * 60 + min;
}

/**
 * Is the store open? Mirrors `store_is_open()` so the API and any SQL-side
 * filtering can never disagree.
 *
 * A slot whose close is at or before its open is treated as crossing
 * midnight — chop bars closing at 02:00 are the norm in Accra, and treating
 * that as an invalid range would silently close half the food catalogue.
 */
export function isOpenAt(
  hours: OperatingHours, override: boolean | null | undefined, at: Date,
): boolean {
  if (override !== null && override !== undefined) return override;
  const { day, minutes } = accraParts(at);
  const slot = hours[day as keyof OperatingHours];
  if (!slot) {
    // Might still be inside yesterday's overnight slot.
    return inYesterdayOvernight(hours, at);
  }
  const open = parseHHMM(slot.open);
  const close = parseHHMM(slot.close);
  if (close > open) return minutes >= open && minutes < close;
  return minutes >= open || inYesterdayOvernight(hours, at);
}

function inYesterdayOvernight(hours: OperatingHours, at: Date): boolean {
  const idx = at.getUTCDay();
  const yesterday = DAY_KEYS[(idx + 6) % 7]!;
  const slot = hours[yesterday as keyof OperatingHours];
  if (!slot) return false;
  const open = parseHHMM(slot.open);
  const close = parseHHMM(slot.close);
  if (close > open) return false;              // not an overnight slot
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  return minutes < close;
}

export function validateHours(hours: OperatingHours): void {
  for (const [day, slot] of Object.entries(hours)) {
    if (!DAY_KEYS.includes(day as any)) {
      throw new ValidationError({ operatingHours: [`"${day}" is not a day key`] });
    }
    if (slot) { parseHHMM(slot.open); parseHHMM(slot.close); }
  }
}

/* ------------------------------------------------------------------ */
/* Prep time                                                           */
/* ------------------------------------------------------------------ */

/**
 * Advertised prep window. Deliberately PESSIMISTIC: we round the lower bound
 * DOWN to the enclosing 10-minute band and the upper bound UP, so a 25-minute
 * average shows "20-40 min" rather than "20-30". Under-promising costs a few
 * conversions; over-promising costs a refund and a one-star review.
 */
export function prepRange(averageMinutes: number): { min: number; max: number; label: string } {
  const avg = Math.max(5, Math.round(averageMinutes));
  const min = Math.max(10, Math.floor(avg / 10) * 10);
  const max = Math.ceil((avg + 10) / 10) * 10;
  return { min, max, label: `${min}-${max} min` };
}

/* ------------------------------------------------------------------ */
/* Ranking (PDF §10)                                                   */
/* ------------------------------------------------------------------ */

export interface RankInput {
  distanceMetres: number;
  rating: number;
  orders30d: number;
  prepMinutes: number;
}

/** Mirrors `store_rank_score()` in 001_catalogue.sql exactly. */
export function rankScore(i: RankInput): number {
  const proximity = 1 / (1 + Math.max(i.distanceMetres, 0) / 3000);
  const rating = Math.min(Math.max(i.rating, 0), 5) / 5;
  const volume = Math.min(Math.max(i.orders30d, 0) / 500, 1);
  const speed = 1 / (1 + Math.max(i.prepMinutes, 1) / 20);
  return 0.3 * proximity + 0.3 * rating + 0.2 * volume + 0.2 * speed;
}

/* ------------------------------------------------------------------ */
/* Item option validation                                              */
/* ------------------------------------------------------------------ */

export interface AddonItem { id: string; name: string; pricePesewas: bigint; isAvailable: boolean }
export interface AddonGroup {
  id: string; name: string; isRequired: boolean;
  minSelections: number; maxSelections: number;
  items: AddonItem[];
}
export interface VariantOption {
  id: string; name: string; priceDeltaPesewas: bigint; isAvailable: boolean;
}
export interface VariantGroup { id: string; name: string; options: VariantOption[] }

export interface CatalogueItem {
  id: string;
  storeId: string;
  name: string;
  description?: string | null;
  basePricePesewas: bigint;
  isAvailable: boolean;
  requiresPrescription: boolean;
  substitutionAllowed: boolean;
  addonGroups: AddonGroup[];
  variantGroups: VariantGroup[];
}

export interface SelectionInput {
  addonItemIds: string[];
  variantOptionIds: string[];
}

/**
 * Price one unit of an item with its chosen options, rejecting any selection
 * the vendor's rules forbid.
 *
 * This runs server-side on every order even though the app validates too:
 * the app's copy of the menu can be minutes stale, and a client that skips
 * a required "Protein" group would otherwise produce an order the kitchen
 * cannot fulfil.
 */
export function priceSelection(item: CatalogueItem, sel: SelectionInput): bigint {
  const errors: Record<string, string[]> = {};

  if (!item.isAvailable) errors.item = ['is currently unavailable'];

  let total = item.basePricePesewas;
  const chosenAddons = new Set(sel.addonItemIds);

  for (const g of item.addonGroups) {
    const picked = g.items.filter((a) => chosenAddons.has(a.id));
    for (const a of picked) {
      if (!a.isAvailable) (errors[g.name] ??= []).push(`"${a.name}" is sold out`);
      total += a.pricePesewas;
      chosenAddons.delete(a.id);
    }
    if (picked.length < g.minSelections) {
      (errors[g.name] ??= []).push(`choose at least ${g.minSelections}`);
    }
    if (picked.length > g.maxSelections) {
      (errors[g.name] ??= []).push(`choose at most ${g.maxSelections}`);
    }
  }

  // Anything left over referenced an addon that is not on this item at all —
  // usually a stale cart after the vendor edited the menu.
  if (chosenAddons.size > 0) {
    errors.addons = ['this item no longer offers some of your choices'];
  }

  const chosenVariants = new Set(sel.variantOptionIds);
  for (const g of item.variantGroups) {
    const picked = g.options.filter((o) => chosenVariants.has(o.id));
    // A variant group is always exactly-one (colour, size). That is what
    // distinguishes it from an addon group.
    if (picked.length !== 1) {
      (errors[g.name] ??= []).push('choose exactly 1');
    }
    for (const o of picked) {
      if (!o.isAvailable) (errors[g.name] ??= []).push(`"${o.name}" is out of stock`);
      total += o.priceDeltaPesewas;
      chosenVariants.delete(o.id);
    }
  }
  if (chosenVariants.size > 0) {
    errors.variants = ['this item no longer offers some of your choices'];
  }

  if (total < 0n) errors.price = ['option discounts cannot make an item free'];

  if (Object.keys(errors).length) throw new ValidationError(errors);
  return total;
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

export interface StoreSummary {
  id: string;
  serviceType: ServiceType;
  name: string;
  latitude: number;
  longitude: number;
  landmark?: string | null;
  averageRating: number;
  totalOrders: number;
  averagePrepMinutes: number;
  operatingHours: OperatingHours;
  isOpenOverride: boolean | null;
  status: StoreStatus;
  isActive: boolean;
}

export interface DiscoveryResult extends StoreSummary {
  distanceMetres: number;
  isOpen: boolean;
  score: number;
  prepLabel: string;
}

export interface DiscoveryOptions {
  service?: ServiceType;
  /** Hard cut-off. Beyond this a rider trip stops being economic. */
  radiusMetres?: number;
  openOnly?: boolean;
  query?: string;
  limit?: number;
  now?: Date;
}

export const DEFAULT_DISCOVERY_RADIUS_METRES = 8_000;

/**
 * Rank stores for a customer standing at `origin`.
 *
 * Closed stores are ranked but pushed below every open one rather than
 * hidden: a customer searching for a specific waakye joint at 6am should see
 * it with "opens at 11:00" instead of concluding Besonc does not have it.
 */
export function discover(
  stores: StoreSummary[], origin: LatLng, opts: DiscoveryOptions = {},
): DiscoveryResult[] {
  const now = opts.now ?? new Date();
  const radius = opts.radiusMetres ?? DEFAULT_DISCOVERY_RADIUS_METRES;
  const q = opts.query?.trim().toLowerCase();

  const rows = stores
    .filter((s) => s.isActive && s.status === 'approved')
    .filter((s) => !opts.service || s.serviceType === opts.service)
    .filter((s) => !q || s.name.toLowerCase().includes(q))
    .map((s): DiscoveryResult => {
      const distanceMetres = haversineMetres(
        origin, { lat: s.latitude, lng: s.longitude },
      );
      const isOpen = isOpenAt(s.operatingHours, s.isOpenOverride, now);
      return {
        ...s,
        distanceMetres: Math.round(distanceMetres),
        isOpen,
        score: rankScore({
          distanceMetres,
          rating: s.averageRating,
          orders30d: s.totalOrders,
          prepMinutes: s.averagePrepMinutes,
        }),
        prepLabel: prepRange(s.averagePrepMinutes).label,
      };
    })
    .filter((s) => s.distanceMetres <= radius)
    .filter((s) => !opts.openOnly || s.isOpen);

  rows.sort((a, b) => {
    if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
    return b.score - a.score;
  });

  return rows.slice(0, opts.limit ?? 50);
}
