/**
 * Cart. PDF §13 (one vendor per cart) and §2 (addons / variants).
 *
 * SECURITY RULE: the client never sends prices. Every pesewa is recomputed
 * server-side from the catalogue snapshot. A cart line carries item IDs and
 * quantities only — anything else is advisory and ignored.
 */

import { add, mul, pesewas, type Pesewas } from '../../../../libs/money/src/money.ts';
import { ValidationError, ConflictError, NotFoundError } from '../../../../libs/platform/src/errors.ts';

export type ServiceType =
  | 'food' | 'groceries' | 'shop' | 'market' | 'pharmacy' | 'laundry';

/* ---------- catalogue snapshot (read model from catalogue-svc) ---------- */

export interface AddonOption {
  id: string;
  name: string;
  pricePesewas: number;
  available: boolean;
}

export interface AddonGroup {
  id: string;
  name: string;
  required: boolean;
  minSelections: number;
  maxSelections: number;
  options: AddonOption[];
}

export interface VariantOption {
  id: string;
  name: string;
  priceDeltaPesewas: number;
  available: boolean;
}

export interface VariantGroup {
  id: string;
  name: string;
  options: VariantOption[];
}

export interface CatalogueItem {
  id: string;
  storeId: string;
  name: string;
  basePricePesewas: number;
  available: boolean;
  requiresPrescription: boolean;
  addonGroups: AddonGroup[];
  variantGroups: VariantGroup[];
}

export interface Store {
  id: string;
  name: string;
  serviceType: ServiceType;
  isOpen: boolean;
  status: 'pending_review' | 'approved' | 'suspended' | 'rejected';
}

export interface CatalogueReader {
  getStore(storeId: string): Promise<Store | null>;
  getItem(itemId: string): Promise<CatalogueItem | null>;
}

/* ---------------------------- cart model ---------------------------- */

export interface CartLineInput {
  itemId: string;
  quantity: number;
  /** Chosen addon option IDs. */
  addonOptionIds?: string[];
  /** Chosen variant option IDs — exactly one per variant group. */
  variantOptionIds?: string[];
  note?: string;
}

export interface PricedLine {
  itemId: string;
  name: string;
  quantity: number;
  unitBasePesewas: Pesewas;
  addonsPesewas: Pesewas;
  variantsPesewas: Pesewas;
  /** (base + addons + variants) × quantity */
  lineTotalPesewas: Pesewas;
  addonNames: string[];
  variantNames: string[];
  note?: string;
}

export interface Cart {
  customerId: string;
  storeId: string | null;
  serviceType: ServiceType | null;
  lines: PricedLine[];
  itemTotalPesewas: Pesewas;
  requiresPrescription: boolean;
}

export const EMPTY_CART = (customerId: string): Cart => ({
  customerId, storeId: null, serviceType: null,
  lines: [], itemTotalPesewas: 0n, requiresPrescription: false,
});

/** Raised when adding an item from a different vendor (PDF §13). */
export class DifferentVendorError extends ConflictError {
  constructor(readonly currentStoreName: string, readonly newStoreName: string) {
    super(
      `Your cart has items from ${currentStoreName}. Start a new cart to order from ${newStoreName}?`,
    );
  }
}

export class CartService {
  constructor(private readonly catalogue: CatalogueReader) {}

  /**
   * Recompute a whole cart from scratch against the live catalogue.
   * Called on every mutation and again at checkout, so a price change or an
   * item going out of stock is always caught before payment.
   */
  async price(customerId: string, inputs: CartLineInput[]): Promise<Cart> {
    if (inputs.length === 0) return EMPTY_CART(customerId);

    const cart = EMPTY_CART(customerId);
    let store: Store | null = null;

    for (const input of inputs) {
      if (!Number.isInteger(input.quantity) || input.quantity < 1) {
        throw new ValidationError({ quantity: [`must be a positive integer, got ${input.quantity}`] });
      }
      if (input.quantity > 99) {
        throw new ValidationError({ quantity: ['maximum 99 per line'] });
      }

      const item = await this.catalogue.getItem(input.itemId);
      if (!item) throw new NotFoundError(`Item ${input.itemId}`);
      if (!item.available) {
        throw new ConflictError(`${item.name} is currently unavailable`);
      }

      /* ---- one vendor per cart (PDF §13) ---- */
      if (store === null) {
        store = await this.catalogue.getStore(item.storeId);
        if (!store) throw new NotFoundError(`Store ${item.storeId}`);
        if (store.status !== 'approved') {
          throw new ConflictError(`${store.name} is not accepting orders`);
        }
        cart.storeId = store.id;
        cart.serviceType = store.serviceType;
      } else if (item.storeId !== store.id) {
        const other = await this.catalogue.getStore(item.storeId);
        throw new DifferentVendorError(store.name, other?.name ?? 'another vendor');
      }

      cart.lines.push(this.priceLine(item, input));
      if (item.requiresPrescription) cart.requiresPrescription = true;
    }

    cart.itemTotalPesewas = add(...cart.lines.map((l) => l.lineTotalPesewas));
    return cart;
  }

  private priceLine(item: CatalogueItem, input: CartLineInput): PricedLine {
    const selectedAddons = new Set(input.addonOptionIds ?? []);
    const selectedVariants = new Set(input.variantOptionIds ?? []);

    /* ---- addon group rules ---- */
    let addonsTotal: Pesewas = 0n;
    const addonNames: string[] = [];

    for (const group of item.addonGroups) {
      const chosen = group.options.filter((o) => selectedAddons.has(o.id));

      if (chosen.length < group.minSelections) {
        throw new ValidationError({
          [group.name]: [`choose at least ${group.minSelections}`],
        });
      }
      if (chosen.length > group.maxSelections) {
        throw new ValidationError({
          [group.name]: [`choose at most ${group.maxSelections}`],
        });
      }
      if (group.required && chosen.length === 0) {
        throw new ValidationError({ [group.name]: ['is required'] });
      }
      for (const opt of chosen) {
        if (!opt.available) {
          throw new ConflictError(`${opt.name} is out of stock`);
        }
        addonsTotal = add(addonsTotal, pesewas(opt.pricePesewas));
        addonNames.push(opt.name);
      }
    }

    /* ---- variant group rules: exactly one per group ---- */
    let variantsTotal: Pesewas = 0n;
    const variantNames: string[] = [];

    for (const group of item.variantGroups) {
      const chosen = group.options.filter((o) => selectedVariants.has(o.id));
      if (chosen.length !== 1) {
        throw new ValidationError({
          [group.name]: [`choose exactly one ${group.name.toLowerCase()}`],
        });
      }
      const opt = chosen[0]!;
      if (!opt.available) throw new ConflictError(`${opt.name} is out of stock`);
      variantsTotal = add(variantsTotal, pesewas(opt.priceDeltaPesewas));
      variantNames.push(opt.name);
    }

    /* ---- reject selections that don't belong to this item ---- */
    const validAddonIds = new Set(item.addonGroups.flatMap((g) => g.options.map((o) => o.id)));
    for (const id of selectedAddons) {
      if (!validAddonIds.has(id)) {
        throw new ValidationError({ addons: [`option ${id} does not belong to ${item.name}`] });
      }
    }
    const validVariantIds = new Set(item.variantGroups.flatMap((g) => g.options.map((o) => o.id)));
    for (const id of selectedVariants) {
      if (!validVariantIds.has(id)) {
        throw new ValidationError({ variants: [`option ${id} does not belong to ${item.name}`] });
      }
    }

    const unitBase = pesewas(item.basePricePesewas);
    const perUnit = add(unitBase, addonsTotal, variantsTotal);

    return {
      itemId: item.id,
      name: item.name,
      quantity: input.quantity,
      unitBasePesewas: unitBase,
      addonsPesewas: mul(addonsTotal, input.quantity),
      variantsPesewas: mul(variantsTotal, input.quantity),
      lineTotalPesewas: mul(perUnit, input.quantity),
      addonNames,
      variantNames,
      ...(input.note ? { note: input.note } : {}),
    };
  }

  /**
   * Checkout gate. Re-prices, then applies the rules that must hold at the
   * moment money is taken.
   */
  async validateForCheckout(
    customerId: string,
    inputs: CartLineInput[],
    opts: { prescriptionUploaded?: boolean } = {},
  ): Promise<Cart> {
    const cart = await this.price(customerId, inputs);
    if (cart.lines.length === 0) throw new ValidationError({ cart: ['is empty'] });

    const store = await this.catalogue.getStore(cart.storeId!);
    if (!store) throw new NotFoundError('Store');
    if (!store.isOpen) throw new ConflictError(`${store.name} is closed right now`);

    // PDF §2: prescription upload becomes mandatory if any item needs one
    if (cart.requiresPrescription && !opts.prescriptionUploaded) {
      throw new ValidationError({
        prescription: ['A prescription is required for one or more items in this order'],
      });
    }
    return cart;
  }
}
