/**
 * Pricing engine. PDF §6, MASTER_PLAN §3.1.
 *
 * Every rate here is DATA, not code — admin edits them at runtime without a
 * deploy (PDF §6: "Store pricing rules in a configuration service/database,
 * not hardcoded"). The values below are the launch defaults.
 *
 * All money is integer pesewas via libs/money. No floats, ever.
 */

import { add, bps, clamp, mul, pesewas, type Pesewas } from '../../../libs/money/src/money.ts';
import { AppError } from '../../../libs/platform/src/errors.ts';

export type ServiceType =
  | 'food' | 'groceries' | 'shop' | 'market_catalogue' | 'market_list'
  | 'pharmacy' | 'laundry' | 'parcel' | 'errand';

export interface DeliveryFeeTier {
  /** Upper bound of the tier in metres; Infinity for the last. */
  maxMetres: number;
  basePesewas: number;
  perKmPesewas: number;
}

export interface PricingConfig {
  deliveryTiers: DeliveryFeeTier[];
  /** Service fee in basis points, with floor/ceiling. 1500 = 15%. */
  serviceFeeBps: Record<ServiceType, number>;
  serviceFeeMin: Record<string, number>;
  serviceFeeMax: Record<string, number>;
  /** Flat service fee overrides (parcel). */
  serviceFeeFlat: Partial<Record<ServiceType, number>>;
  /** Platform commission taken from the vendor, in bps. */
  commissionBps: Partial<Record<ServiceType, number>>;
  surcharges: {
    peakBps: number;      // +20%
    weatherBps: number;   // +15%
    nightBps: number;     // +25%
    fragilePesewas: number;
    heavyPesewas: number;
  };
  parcelWeightBands: Array<{ maxKg: number; basePesewas: number }>;
  parcelRiderShareBps: number;   // 8000 = rider keeps 80%
  errandServiceFeePesewas: number;
  errandToleranceBps: number;    // 1500 = 15% auto-accepted overspend
}

/** Launch defaults — exactly the figures in PDF §6. */
export const DEFAULT_PRICING: PricingConfig = {
  deliveryTiers: [
    { maxMetres: 3_000,  basePesewas: 500,  perKmPesewas: 150 },
    { maxMetres: 7_000,  basePesewas: 800,  perKmPesewas: 120 },
    { maxMetres: 15_000, basePesewas: 1200, perKmPesewas: 100 },
    { maxMetres: Infinity, basePesewas: 1800, perKmPesewas: 80 },
  ],
  serviceFeeBps: {
    food: 500, groceries: 400, shop: 500, market_catalogue: 500,
    market_list: 700, pharmacy: 400, laundry: 500, parcel: 0, errand: 800,
  },
  serviceFeeMin: { food: 200 },
  serviceFeeMax: { food: 1500 },
  serviceFeeFlat: { parcel: 300 },
  commissionBps: {
    food: 1500, groceries: 1200, shop: 1000,
    market_catalogue: 1500, market_list: 1500, pharmacy: 1000, laundry: 1200,
  },
  surcharges: {
    peakBps: 2000, weatherBps: 1500, nightBps: 2500,
    fragilePesewas: 1000, heavyPesewas: 500,
  },
  parcelWeightBands: [
    { maxKg: 1,  basePesewas: 1000 },
    { maxKg: 5,  basePesewas: 1500 },
    { maxKg: 10, basePesewas: 2500 },
    { maxKg: 20, basePesewas: 4000 },
  ],
  parcelRiderShareBps: 8000,
  errandServiceFeePesewas: 1500,
  errandToleranceBps: 1500,
};

export interface SurchargeFlags {
  peak?: boolean;
  badWeather?: boolean;
  night?: boolean;
  fragile?: boolean;
  heavy?: boolean;
}

/**
 * Invalid pricing INPUT (negative distance, over-weight parcel, unknown
 * service). These are client errors — surfaced as 422 with a readable
 * message rather than a 500 that tells the customer nothing.
 */
export class PricingError extends AppError {
  constructor(message: string) {
    super(422, 'pricing-invalid', 'Invalid pricing request', message);
  }
}

/* ------------------------------------------------------------------ */
/* Delivery fee                                                        */
/* ------------------------------------------------------------------ */

export function deliveryFee(
  distanceMetres: number,
  flags: SurchargeFlags = {},
  cfg: PricingConfig = DEFAULT_PRICING,
): Pesewas {
  if (!Number.isFinite(distanceMetres) || distanceMetres < 0) {
    throw new PricingError(`invalid distance: ${distanceMetres}`);
  }
  const tier = cfg.deliveryTiers.find((t) => distanceMetres <= t.maxMetres);
  if (!tier) throw new PricingError('no delivery tier matched');

  // Distance component is charged per whole km, rounded up — a 3.2 km trip
  // pays for 4 km. Simple for riders to understand and never under-charges.
  const km = Math.ceil(distanceMetres / 1000);
  let fee = add(pesewas(tier.basePesewas), mul(pesewas(tier.perKmPesewas), km));

  // Percentage surcharges compound additively on the base fee, not on
  // each other, so peak+night is +45%, not +50%.
  let surchargeBps = 0;
  if (flags.peak) surchargeBps += cfg.surcharges.peakBps;
  if (flags.badWeather) surchargeBps += cfg.surcharges.weatherBps;
  if (flags.night) surchargeBps += cfg.surcharges.nightBps;
  if (surchargeBps > 0) fee = add(fee, bps(fee, surchargeBps));

  if (flags.fragile) fee = add(fee, pesewas(cfg.surcharges.fragilePesewas));
  if (flags.heavy) fee = add(fee, pesewas(cfg.surcharges.heavyPesewas));

  return fee;
}

/* ------------------------------------------------------------------ */
/* Service fee (customer) and commission (vendor)                      */
/* ------------------------------------------------------------------ */

export function serviceFee(
  itemTotal: Pesewas,
  service: ServiceType,
  cfg: PricingConfig = DEFAULT_PRICING,
): Pesewas {
  const flat = cfg.serviceFeeFlat[service];
  if (flat !== undefined) return pesewas(flat);

  const rate = cfg.serviceFeeBps[service];
  if (rate === undefined) throw new PricingError(`no service fee rate for ${service}`);

  let fee = bps(itemTotal, rate);
  const lo = cfg.serviceFeeMin[service];
  const hi = cfg.serviceFeeMax[service];
  if (lo !== undefined || hi !== undefined) {
    fee = clamp(fee, pesewas(lo ?? 0), pesewas(hi ?? Number.MAX_SAFE_INTEGER));
  }
  return fee;
}

export function commission(
  itemTotal: Pesewas,
  service: ServiceType,
  cfg: PricingConfig = DEFAULT_PRICING,
): Pesewas {
  const rate = cfg.commissionBps[service];
  if (rate === undefined) return 0n; // parcel/errand have no vendor
  return bps(itemTotal, rate);
}

/* ------------------------------------------------------------------ */
/* Full order quote                                                    */
/* ------------------------------------------------------------------ */

export interface QuoteInput {
  service: ServiceType;
  itemTotal: Pesewas;
  distanceMetres: number;
  flags?: SurchargeFlags;
  /** Laundry has two legs; each is charged. */
  legs?: number;
}

export interface Quote {
  itemTotal: Pesewas;
  deliveryFee: Pesewas;
  serviceFee: Pesewas;
  /** What the customer pays. */
  total: Pesewas;
  /** Settlement split — must sum to total. */
  vendorReceives: Pesewas;
  riderReceives: Pesewas;
  platformReceives: Pesewas;
}

export function quote(input: QuoteInput, cfg: PricingConfig = DEFAULT_PRICING): Quote {
  const legs = input.legs ?? 1;
  if (!Number.isInteger(legs) || legs < 1) throw new PricingError(`invalid legs: ${legs}`);

  const perLeg = deliveryFee(input.distanceMetres, input.flags, cfg);
  const delivery = mul(perLeg, legs);
  const svcFee = serviceFee(input.itemTotal, input.service, cfg);
  const total = add(input.itemTotal, delivery, svcFee);

  const comm = commission(input.itemTotal, input.service, cfg);
  const vendorReceives = input.itemTotal - comm;
  const riderReceives = delivery;                 // PDF §6: rider gets the full delivery fee
  const platformReceives = add(comm, svcFee);

  // Invariant — the split must exactly reconstruct the total, or the ledger
  // will refuse the settlement transaction later.
  const reconstructed = add(vendorReceives, riderReceives, platformReceives);
  if (reconstructed !== total) {
    throw new PricingError(
      `quote does not balance: total=${total} split=${reconstructed}`,
    );
  }

  return { itemTotal: input.itemTotal, deliveryFee: delivery, serviceFee: svcFee,
           total, vendorReceives, riderReceives, platformReceives };
}

/* ------------------------------------------------------------------ */
/* Parcel and errand (request engine — no vendor)                      */
/* ------------------------------------------------------------------ */

export function parcelQuote(
  weightKg: number,
  distanceMetres: number,
  flags: SurchargeFlags = {},
  cfg: PricingConfig = DEFAULT_PRICING,
): Quote {
  const band = cfg.parcelWeightBands.find((b) => weightKg <= b.maxKg);
  if (!band) throw new PricingError(`parcel over max weight: ${weightKg}kg`);

  const weightFee = pesewas(band.basePesewas);
  const distanceComponent = deliveryFee(distanceMetres, flags, cfg);
  const total = add(weightFee, distanceComponent);

  const riderReceives = bps(total, cfg.parcelRiderShareBps);
  const platformReceives = total - riderReceives;

  return {
    itemTotal: 0n, deliveryFee: total, serviceFee: 0n, total,
    vendorReceives: 0n, riderReceives, platformReceives,
  };
}

export interface ErrandQuote extends Quote {
  estimatedItemCost: Pesewas;
  /** Overspend beyond this needs explicit customer approval. */
  autoApproveCeiling: Pesewas;
}

export function errandQuote(
  estimatedItemCost: Pesewas,
  distanceMetres: number,
  flags: SurchargeFlags = {},
  cfg: PricingConfig = DEFAULT_PRICING,
): ErrandQuote {
  const errandFee = pesewas(cfg.errandServiceFeePesewas);
  const delivery = deliveryFee(distanceMetres, flags, cfg);
  const platformCut = bps(estimatedItemCost, cfg.serviceFeeBps.errand);
  const total = add(estimatedItemCost, errandFee, delivery, platformCut);

  return {
    itemTotal: estimatedItemCost,
    deliveryFee: delivery,
    serviceFee: add(errandFee, platformCut),
    total,
    vendorReceives: 0n,
    riderReceives: add(errandFee, delivery),
    platformReceives: platformCut,
    estimatedItemCost,
    autoApproveCeiling: add(estimatedItemCost, bps(estimatedItemCost, cfg.errandToleranceBps)),
  };
}

/* ------------------------------------------------------------------ */
/* COD eligibility (PDF §7)                                            */
/* ------------------------------------------------------------------ */

export interface CodContext {
  orderTotal: Pesewas;
  service: ServiceType;
  customerCompletedOrders: number;
  riderUnremittedCod: Pesewas;
  hourOfDay: number; // 0-23, local time
}

export interface CodDecision {
  eligible: boolean;
  reason?: string;
}

export const COD_RULES = {
  maxOrderPesewas: 20_000,        // GHS 200
  newCustomerMaxPesewas: 5_000,   // GHS 50
  newCustomerThreshold: 3,
  riderMaxUnremittedPesewas: 30_000, // GHS 300
  blockedFromHour: 21,
} as const;

export function codEligible(ctx: CodContext): CodDecision {
  if (ctx.service === 'shop') {
    return { eligible: false, reason: 'Shop orders are prepaid only' };
  }
  if (ctx.orderTotal > pesewas(COD_RULES.maxOrderPesewas)) {
    return { eligible: false, reason: 'Order exceeds the GHS 200 cash limit' };
  }
  if (
    ctx.customerCompletedOrders < COD_RULES.newCustomerThreshold &&
    ctx.orderTotal > pesewas(COD_RULES.newCustomerMaxPesewas)
  ) {
    return { eligible: false, reason: 'New customers may pay cash up to GHS 50' };
  }
  if (ctx.riderUnremittedCod > pesewas(COD_RULES.riderMaxUnremittedPesewas)) {
    return { eligible: false, reason: 'No rider available for cash orders right now' };
  }
  if (ctx.hourOfDay >= COD_RULES.blockedFromHour || ctx.hourOfDay < 6) {
    return { eligible: false, reason: 'Cash on delivery is unavailable after 9pm' };
  }
  return { eligible: true };
}
