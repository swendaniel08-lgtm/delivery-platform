/**
 * catalogue-svc persistence.
 *
 * The read path is the hottest in the platform — every app launch hits
 * discovery — so the Postgres implementation deliberately assembles a store's
 * full menu in ONE round trip using JSON aggregation rather than the
 * N+1 that a naive ORM mapping would produce.
 */

import type { Pool } from 'pg';
import { NotFoundError } from '../../../libs/platform/src/errors.ts';
import type {
  CatalogueItem, StoreSummary, ServiceType, StoreStatus, OperatingHours,
  AddonGroup, VariantGroup,
} from './catalogue.ts';

export interface StoreInput {
  ownerId: string;
  serviceType: ServiceType;
  name: string;
  description?: string | null;
  latitude: number;
  longitude: number;
  landmark?: string | null;
  phone: string;
  operatingHours?: OperatingHours;
  pharmacyLicenseNumber?: string | null;
}

export interface ItemInput {
  storeId: string;
  categoryId?: string | null;
  name: string;
  description?: string | null;
  basePricePesewas: bigint;
  unit?: string | null;
  requiresPrescription?: boolean;
  substitutionAllowed?: boolean;
  prepMinutes?: number | null;
}

export interface CatalogueRepository {
  listStores(filter?: { service?: ServiceType; ownerId?: string }): Promise<StoreSummary[]>;
  getStore(id: string): Promise<StoreSummary>;
  createStore(input: StoreInput): Promise<StoreSummary>;
  setStoreStatus(id: string, status: StoreStatus): Promise<StoreSummary>;
  setOpenOverride(id: string, override: boolean | null): Promise<StoreSummary>;

  listItems(storeId: string): Promise<CatalogueItem[]>;
  getItem(id: string): Promise<CatalogueItem>;
  createItem(input: ItemInput): Promise<CatalogueItem>;
  setItemAvailability(id: string, available: boolean): Promise<CatalogueItem>;
  /** Full-text + fuzzy item search across approved stores. */
  searchItems(query: string, opts?: { service?: ServiceType; limit?: number }):
    Promise<Array<CatalogueItem & { storeName: string }>>;
}

/* ------------------------------------------------------------------ */
/* In-memory                                                           */
/* ------------------------------------------------------------------ */

let n = 0;
const uuid = () => {
  n += 1;
  return `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
};

export class InMemoryCatalogueRepository implements CatalogueRepository {
  stores = new Map<string, StoreSummary>();
  /** ownerId per store — StoreSummary does not carry it. */
  owners = new Map<string, string>();
  items = new Map<string, CatalogueItem>();
  storeNames = new Map<string, string>();

  async listStores(filter: { service?: ServiceType; ownerId?: string } = {}) {
    return [...this.stores.values()]
      .filter((s) => !filter.service || s.serviceType === filter.service)
      // Was silently ignored here while the Postgres repository honoured
      // it — the two implementations of one interface must agree, or a
      // test that passes in memory fails in production.
      .filter((s) => !filter.ownerId || this.owners.get(s.id) === filter.ownerId);
  }
  async getStore(id: string) {
    const s = this.stores.get(id);
    if (!s) throw new NotFoundError('Store');
    return { ...s };
  }
  async createStore(input: StoreInput) {
    const s: StoreSummary = {
      id: uuid(),
      serviceType: input.serviceType,
      name: input.name,
      latitude: input.latitude,
      longitude: input.longitude,
      landmark: input.landmark ?? null,
      averageRating: 0,
      totalOrders: 0,
      averagePrepMinutes: 20,
      operatingHours: input.operatingHours ?? {},
      isOpenOverride: null,
      status: 'pending_review',
      isActive: true,
    };
    this.stores.set(s.id, s);
    this.storeNames.set(s.id, s.name);
    this.owners.set(s.id, input.ownerId);
    return { ...s };
  }
  async setStoreStatus(id: string, status: StoreStatus) {
    const s = this.stores.get(id);
    if (!s) throw new NotFoundError('Store');
    s.status = status;
    return { ...s };
  }
  async setOpenOverride(id: string, override: boolean | null) {
    const s = this.stores.get(id);
    if (!s) throw new NotFoundError('Store');
    s.isOpenOverride = override;
    return { ...s };
  }

  async listItems(storeId: string) {
    return [...this.items.values()].filter((i) => i.storeId === storeId).map((i) => ({ ...i }));
  }
  async getItem(id: string) {
    const i = this.items.get(id);
    if (!i) throw new NotFoundError('Item');
    return { ...i };
  }
  async createItem(input: ItemInput) {
    const item: CatalogueItem = {
      id: uuid(),
      storeId: input.storeId,
      name: input.name,
      description: input.description ?? null,
      basePricePesewas: input.basePricePesewas,
      isAvailable: true,
      requiresPrescription: input.requiresPrescription ?? false,
      substitutionAllowed: input.substitutionAllowed ?? true,
      addonGroups: [],
      variantGroups: [],
    };
    this.items.set(item.id, item);
    return { ...item };
  }
  async setItemAvailability(id: string, available: boolean) {
    const i = this.items.get(id);
    if (!i) throw new NotFoundError('Item');
    i.isAvailable = available;
    return { ...i };
  }
  async searchItems(query: string, opts: { service?: ServiceType; limit?: number } = {}) {
    const q = query.trim().toLowerCase();
    return [...this.items.values()]
      .filter((i) => {
        const store = this.stores.get(i.storeId);
        if (!store || store.status !== 'approved' || !store.isActive) return false;
        if (opts.service && store.serviceType !== opts.service) return false;
        return i.name.toLowerCase().includes(q)
          || (i.description ?? '').toLowerCase().includes(q);
      })
      .slice(0, opts.limit ?? 30)
      .map((i) => ({ ...i, storeName: this.storeNames.get(i.storeId) ?? '' }));
  }

  /** Test helper — attach option groups without an admin endpoint. */
  attachOptions(itemId: string, addons: AddonGroup[], variants: VariantGroup[] = []) {
    const i = this.items.get(itemId)!;
    i.addonGroups = addons;
    i.variantGroups = variants;
  }
}

/* ------------------------------------------------------------------ */
/* Postgres                                                            */
/* ------------------------------------------------------------------ */

function toStore(r: any): StoreSummary {
  return {
    id: r.id,
    serviceType: r.service_type,
    name: r.name,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    landmark: r.landmark,
    averageRating: Number(r.average_rating),
    totalOrders: Number(r.total_orders),
    averagePrepMinutes: Number(r.average_prep_minutes),
    operatingHours: r.operating_hours ?? {},
    isOpenOverride: r.is_open_override,
    status: r.status,
    isActive: r.is_active,
  };
}

function toItem(r: any): CatalogueItem {
  return {
    id: r.id,
    storeId: r.store_id,
    name: r.name,
    description: r.description,
    // Money crosses the pg driver as a string because BIGINT overflows a
    // JS number. BigInt() here is the ONLY correct conversion.
    basePricePesewas: BigInt(r.base_price_pesewas),
    isAvailable: r.is_available,
    requiresPrescription: r.requires_prescription,
    substitutionAllowed: r.substitution_allowed,
    addonGroups: (r.addon_groups ?? []).map((g: any): AddonGroup => ({
      id: g.id, name: g.name, isRequired: g.is_required,
      minSelections: g.min_selections, maxSelections: g.max_selections,
      items: (g.items ?? []).map((a: any) => ({
        id: a.id, name: a.name,
        pricePesewas: BigInt(a.price_pesewas), isAvailable: a.is_available,
      })),
    })),
    variantGroups: (r.variant_groups ?? []).map((g: any): VariantGroup => ({
      id: g.id, name: g.name,
      options: (g.options ?? []).map((o: any) => ({
        id: o.id, name: o.name,
        priceDeltaPesewas: BigInt(o.price_delta_pesewas), isAvailable: o.is_available,
      })),
    })),
  };
}

/** One query, no N+1: the whole option tree comes back as nested JSON. */
const ITEM_SELECT = `
  SELECT i.*,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', g.id, 'name', g.name, 'is_required', g.is_required,
        'min_selections', g.min_selections, 'max_selections', g.max_selections,
        'items', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', a.id, 'name', a.name,
            'price_pesewas', a.price_pesewas::text, 'is_available', a.is_available
          ) ORDER BY a.sort_order)
          FROM addon_items a WHERE a.addon_group_id = g.id
        ), '[]'::jsonb)
      ) ORDER BY g.sort_order)
      FROM addon_groups g WHERE g.item_id = i.id
    ), '[]'::jsonb) AS addon_groups,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', v.id, 'name', v.name,
        'options', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', o.id, 'name', o.name,
            'price_delta_pesewas', o.price_delta_pesewas::text, 'is_available', o.is_available
          ) ORDER BY o.sort_order)
          FROM variant_options o WHERE o.variant_group_id = v.id
        ), '[]'::jsonb)
      ) ORDER BY v.sort_order)
      FROM variant_groups v WHERE v.item_id = i.id
    ), '[]'::jsonb) AS variant_groups
  FROM items i`;

export class PgCatalogueRepository implements CatalogueRepository {
  constructor(private readonly pool: Pool) {}

  async listStores(filter: { service?: ServiceType; ownerId?: string } = {}) {
    const r = await this.pool.query(
      `SELECT * FROM stores
        WHERE ($1::service_type IS NULL OR service_type = $1)
          AND ($2::uuid IS NULL OR owner_id = $2)
        ORDER BY created_at DESC`,
      [filter.service ?? null, filter.ownerId ?? null],
    );
    return r.rows.map(toStore);
  }

  async getStore(id: string) {
    const r = await this.pool.query('SELECT * FROM stores WHERE id = $1', [id]);
    if (!r.rows[0]) throw new NotFoundError('Store');
    return toStore(r.rows[0]);
  }

  async createStore(input: StoreInput) {
    const r = await this.pool.query(
      `INSERT INTO stores
         (owner_id, service_type, name, description, latitude, longitude,
          landmark, phone, operating_hours, pharmacy_license_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING *`,
      [input.ownerId, input.serviceType, input.name, input.description ?? null,
        input.latitude, input.longitude, input.landmark ?? null, input.phone,
        JSON.stringify(input.operatingHours ?? {}), input.pharmacyLicenseNumber ?? null],
    );
    return toStore(r.rows[0]);
  }

  async setStoreStatus(id: string, status: StoreStatus) {
    const r = await this.pool.query(
      'UPDATE stores SET status = $2 WHERE id = $1 RETURNING *', [id, status],
    );
    if (!r.rows[0]) throw new NotFoundError('Store');
    return toStore(r.rows[0]);
  }

  async setOpenOverride(id: string, override: boolean | null) {
    const r = await this.pool.query(
      'UPDATE stores SET is_open_override = $2 WHERE id = $1 RETURNING *', [id, override],
    );
    if (!r.rows[0]) throw new NotFoundError('Store');
    return toStore(r.rows[0]);
  }

  async listItems(storeId: string) {
    const r = await this.pool.query(
      `${ITEM_SELECT} WHERE i.store_id = $1 ORDER BY i.sort_order, i.name`, [storeId],
    );
    return r.rows.map(toItem);
  }

  async getItem(id: string) {
    const r = await this.pool.query(`${ITEM_SELECT} WHERE i.id = $1`, [id]);
    if (!r.rows[0]) throw new NotFoundError('Item');
    return toItem(r.rows[0]);
  }

  async createItem(input: ItemInput) {
    const r = await this.pool.query(
      `INSERT INTO items
         (store_id, category_id, name, description, base_price_pesewas, unit,
          requires_prescription, substitution_allowed, prep_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [input.storeId, input.categoryId ?? null, input.name, input.description ?? null,
        input.basePricePesewas.toString(), input.unit ?? null,
        input.requiresPrescription ?? false, input.substitutionAllowed ?? true,
        input.prepMinutes ?? null],
    );
    return this.getItem(r.rows[0].id);
  }

  async setItemAvailability(id: string, available: boolean) {
    const r = await this.pool.query(
      'UPDATE items SET is_available = $2 WHERE id = $1 RETURNING id', [id, available],
    );
    if (!r.rows[0]) throw new NotFoundError('Item');
    return this.getItem(id);
  }

  async searchItems(query: string, opts: { service?: ServiceType; limit?: number } = {}) {
    // tsquery for real words, trigram similarity as the safety net for the
    // typos and local spellings ("waakye"/"waachi") a dictionary never has.
    const r = await this.pool.query(
      `${ITEM_SELECT}
        JOIN stores s ON s.id = i.store_id
       WHERE s.status = 'approved' AND s.is_active AND i.is_available
         AND ($2::service_type IS NULL OR s.service_type = $2)
         AND (i.search_tsv @@ plainto_tsquery('simple', $1)
              OR i.name % $1)
       ORDER BY ts_rank(i.search_tsv, plainto_tsquery('simple', $1)) DESC,
                similarity(i.name, $1) DESC
       LIMIT $3`,
      [query, opts.service ?? null, opts.limit ?? 30],
    );
    // storeName needs a second lookup only for the ids we actually returned.
    const ids = [...new Set(r.rows.map((x: any) => x.store_id))];
    const names = ids.length
      ? await this.pool.query('SELECT id, name FROM stores WHERE id = ANY($1)', [ids])
      : { rows: [] as any[] };
    const nameById = new Map(names.rows.map((x: any) => [x.id, x.name]));
    return r.rows.map((row: any) => ({
      ...toItem(row), storeName: nameById.get(row.store_id) ?? '',
    }));
  }
}
