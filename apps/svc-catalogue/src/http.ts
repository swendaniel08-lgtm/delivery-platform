/**
 * catalogue-svc HTTP surface.
 *
 * Three audiences share these routes:
 *   • customers  — GET discovery, store pages, search
 *   • vendors    — POST/PATCH their own menu, toggle open/closed
 *   • admins     — approve or suspend a store
 *
 * Authorisation is enforced from the JWT the gateway forwards, so a vendor
 * cannot edit another vendor's menu even by guessing ids.
 */

import 'reflect-metadata';
import {
  Module, Controller, Get, Post, Patch, Body, Param, Query, Headers,
  Inject, type DynamicModule,
} from '@nestjs/common';
import type { Pool } from 'pg';

import { HealthModule } from '../../../libs/platform/src/service/bootstrap.ts';
import {
  ValidationError, UnauthorizedError, ForbiddenError, NotFoundError,
} from '../../../libs/platform/src/errors.ts';
import {
  discover, priceSelection, prepRange, isOpenAt, validateHours,
  SERVICE_TYPES, DEFAULT_DISCOVERY_RADIUS_METRES,
  type ServiceType, type CatalogueItem, type StoreSummary,
} from './catalogue.ts';
import {
  InMemoryCatalogueRepository, PgCatalogueRepository, type CatalogueRepository,
} from './repository.ts';

export const CATALOGUE_REPO = Symbol('CATALOGUE_REPO');
export const VERIFY_TOKEN = Symbol('VERIFY_TOKEN');

/** Minimal claim shape; the real verification lives in identity-svc. */
export interface Claims { sub: string; role: string; vendorId?: string }
export type VerifyToken = (token: string) => Claims;

function requireFields(body: any, fields: string[]): void {
  const errors: Record<string, string[]> = {};
  for (const f of fields) {
    if (body?.[f] === undefined || body[f] === null || body[f] === '') errors[f] = ['is required'];
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
}

function storeDto(s: StoreSummary, now = new Date()) {
  return {
    id: s.id,
    serviceType: s.serviceType,
    name: s.name,
    latitude: s.latitude,
    longitude: s.longitude,
    landmark: s.landmark ?? null,
    averageRating: s.averageRating,
    totalOrders: s.totalOrders,
    prepLabel: prepRange(s.averagePrepMinutes).label,
    isOpen: isOpenAt(s.operatingHours, s.isOpenOverride, now),
    operatingHours: s.operatingHours,
    status: s.status,
  };
}

function itemDto(i: CatalogueItem) {
  return {
    id: i.id,
    storeId: i.storeId,
    name: i.name,
    description: i.description ?? null,
    // Pesewas as STRINGS on the wire — JSON cannot carry a bigint.
    basePricePesewas: i.basePricePesewas.toString(),
    isAvailable: i.isAvailable,
    requiresPrescription: i.requiresPrescription,
    substitutionAllowed: i.substitutionAllowed,
    addonGroups: i.addonGroups.map((g) => ({
      id: g.id, name: g.name, isRequired: g.isRequired,
      minSelections: g.minSelections, maxSelections: g.maxSelections,
      items: g.items.map((a) => ({
        id: a.id, name: a.name,
        pricePesewas: a.pricePesewas.toString(), isAvailable: a.isAvailable,
      })),
    })),
    variantGroups: i.variantGroups.map((g) => ({
      id: g.id, name: g.name,
      options: g.options.map((o) => ({
        id: o.id, name: o.name,
        priceDeltaPesewas: o.priceDeltaPesewas.toString(), isAvailable: o.isAvailable,
      })),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Public discovery                                                    */
/* ------------------------------------------------------------------ */

@Controller('catalogue')
export class DiscoveryController {
  constructor(@Inject(CATALOGUE_REPO) private readonly repo: CatalogueRepository) {}

  /** The home screen. `lat`/`lng` are required — everything is proximity-first. */
  @Get('stores')
  async stores(@Query() q: any) {
    const lat = Number(q.lat);
    const lng = Number(q.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new ValidationError({ lat: ['lat and lng are required'] });
    }
    if (q.service && !SERVICE_TYPES.includes(q.service)) {
      throw new ValidationError({ service: [`must be one of ${SERVICE_TYPES.join(', ')}`] });
    }

    const all = await this.repo.listStores(q.service ? { service: q.service } : {});
    const rows = discover(all, { lat, lng }, {
      ...(q.service ? { service: q.service as ServiceType } : {}),
      ...(q.radiusMetres ? { radiusMetres: Number(q.radiusMetres) } : {}),
      ...(q.q ? { query: String(q.q) } : {}),
      openOnly: q.openOnly === 'true',
      ...(q.limit ? { limit: Number(q.limit) } : {}),
    });

    return {
      radiusMetres: q.radiusMetres ? Number(q.radiusMetres) : DEFAULT_DISCOVERY_RADIUS_METRES,
      stores: rows.map((r) => ({
        ...storeDto(r),
        distanceMetres: r.distanceMetres,
        isOpen: r.isOpen,
        prepLabel: r.prepLabel,
      })),
    };
  }

  /** The store page: details plus the whole menu in one call. */
  @Get('stores/:id')
  async store(@Param('id') id: string) {
    const s = await this.repo.getStore(id);
    if (s.status !== 'approved' || !s.isActive) throw new NotFoundError('Store');
    const items = await this.repo.listItems(id);
    return { store: storeDto(s), items: items.map(itemDto) };
  }

  @Get('items/:id')
  async item(@Param('id') id: string) {
    return itemDto(await this.repo.getItem(id));
  }

  @Get('search')
  async search(@Query() q: any) {
    const term = String(q.q ?? '').trim();
    if (term.length < 2) {
      throw new ValidationError({ q: ['type at least 2 characters'] });
    }
    const items = await this.repo.searchItems(term, {
      ...(q.service ? { service: q.service as ServiceType } : {}),
      ...(q.limit ? { limit: Number(q.limit) } : {}),
    });
    return { query: term, items: items.map((i) => ({ ...itemDto(i), storeName: i.storeName })) };
  }

  /**
   * Server-side pricing of a configured item. The cart calls this before
   * checkout so the price shown is the price the order service will charge.
   */
  @Post('items/:id/price')
  async price(@Param('id') id: string, @Body() body: any) {
    const item = await this.repo.getItem(id);
    const unit = priceSelection(item, {
      addonItemIds: Array.isArray(body?.addonItemIds) ? body.addonItemIds : [],
      variantOptionIds: Array.isArray(body?.variantOptionIds) ? body.variantOptionIds : [],
    });
    const qty = Math.max(1, Math.floor(Number(body?.quantity ?? 1)));
    if (qty > 50) throw new ValidationError({ quantity: ['maximum 50 per line'] });
    return {
      unitPricePesewas: unit.toString(),
      quantity: qty,
      linePesewas: (unit * BigInt(qty)).toString(),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Vendor + admin management                                           */
/* ------------------------------------------------------------------ */

@Controller('catalogue/manage')
export class ManagementController {
  constructor(
    @Inject(CATALOGUE_REPO) private readonly repo: CatalogueRepository,
    @Inject(VERIFY_TOKEN) private readonly verify: VerifyToken,
  ) {}

  private claims(auth?: string): Claims {
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedError();
    try { return this.verify(auth.slice(7)); }
    catch { throw new UnauthorizedError('Invalid token'); }
  }

  /** Throws unless the caller owns this store (admins bypass). */
  private async assertOwner(storeId: string, c: Claims): Promise<StoreSummary> {
    const store = await this.repo.getStore(storeId);
    if (c.role === 'admin') return store;
    if (!['vendor_owner', 'vendor_staff'].includes(c.role)) {
      throw new ForbiddenError('Only vendors can manage a menu');
    }
    // vendorId is stamped into the JWT at login by identity-svc.
    if (c.vendorId !== storeId) {
      // 404 rather than 403: probing ids must not confirm they exist.
      throw new NotFoundError('Store');
    }
    return store;
  }

  @Post('stores')
  async createStore(@Body() body: any, @Headers('authorization') auth?: string) {
    const c = this.claims(auth);
    if (!['vendor_owner', 'admin'].includes(c.role)) {
      throw new ForbiddenError('Only a vendor owner can register a store');
    }
    requireFields(body, ['serviceType', 'name', 'latitude', 'longitude', 'phone']);
    if (!SERVICE_TYPES.includes(body.serviceType)) {
      throw new ValidationError({ serviceType: [`must be one of ${SERVICE_TYPES.join(', ')}`] });
    }
    if (body.operatingHours) validateHours(body.operatingHours);
    // A pharmacy without a licence can be created but never approved — the
    // DB check enforces it too, but failing here gives a usable message.
    if (body.serviceType === 'pharmacy' && !body.pharmacyLicenseNumber) {
      throw new ValidationError({
        pharmacyLicenseNumber: ['a pharmacy licence number is required'],
      });
    }

    const s = await this.repo.createStore({
      ownerId: c.sub,
      serviceType: body.serviceType,
      name: String(body.name),
      description: body.description ?? null,
      latitude: Number(body.latitude),
      longitude: Number(body.longitude),
      landmark: body.landmark ?? null,
      phone: String(body.phone),
      operatingHours: body.operatingHours ?? {},
      pharmacyLicenseNumber: body.pharmacyLicenseNumber ?? null,
    });
    return storeDto(s);
  }

  /** The "we've run out of gas" switch. null hands control back to the schedule. */
  @Patch('stores/:id/open')
  async toggleOpen(
    @Param('id') id: string, @Body() body: any, @Headers('authorization') auth?: string,
  ) {
    const c = this.claims(auth);
    await this.assertOwner(id, c);
    const value = body?.isOpen === null || body?.isOpen === undefined ? null : body.isOpen === true;
    return storeDto(await this.repo.setOpenOverride(id, value));
  }

  @Patch('stores/:id/status')
  async setStatus(
    @Param('id') id: string, @Body() body: any, @Headers('authorization') auth?: string,
  ) {
    const c = this.claims(auth);
    // Approval is an admin act. A vendor approving their own pharmacy would
    // defeat the entire licence check.
    if (c.role !== 'admin') throw new ForbiddenError('Only an admin can change store status');
    requireFields(body, ['status']);
    const allowed = ['pending_review', 'approved', 'suspended', 'rejected'];
    if (!allowed.includes(body.status)) {
      throw new ValidationError({ status: [`must be one of ${allowed.join(', ')}`] });
    }
    return storeDto(await this.repo.setStoreStatus(id, body.status));
  }

  @Get('stores/:id/items')
  async listItems(@Param('id') id: string, @Headers('authorization') auth?: string) {
    const c = this.claims(auth);
    await this.assertOwner(id, c);
    // Unlike the public route this includes unavailable items — the vendor
    // needs to see what they have switched off in order to switch it back on.
    return { items: (await this.repo.listItems(id)).map(itemDto) };
  }

  @Post('stores/:id/items')
  async createItem(
    @Param('id') id: string, @Body() body: any, @Headers('authorization') auth?: string,
  ) {
    const c = this.claims(auth);
    await this.assertOwner(id, c);
    requireFields(body, ['name', 'basePricePesewas']);

    let price: bigint;
    try { price = BigInt(body.basePricePesewas); }
    catch { throw new ValidationError({ basePricePesewas: ['must be an integer number of pesewas'] }); }
    if (price < 0n) throw new ValidationError({ basePricePesewas: ['cannot be negative'] });

    const item = await this.repo.createItem({
      storeId: id,
      categoryId: body.categoryId ?? null,
      name: String(body.name),
      description: body.description ?? null,
      basePricePesewas: price,
      unit: body.unit ?? null,
      requiresPrescription: body.requiresPrescription === true,
      substitutionAllowed: body.substitutionAllowed !== false,
      prepMinutes: body.prepMinutes ?? null,
    });
    return itemDto(item);
  }

  /** The most-used vendor endpoint by far: "we're out of tilapia". */
  @Patch('items/:id/availability')
  async availability(
    @Param('id') id: string, @Body() body: any, @Headers('authorization') auth?: string,
  ) {
    const c = this.claims(auth);
    const item = await this.repo.getItem(id);
    await this.assertOwner(item.storeId, c);
    if (typeof body?.isAvailable !== 'boolean') {
      throw new ValidationError({ isAvailable: ['must be true or false'] });
    }
    return itemDto(await this.repo.setItemAvailability(id, body.isAvailable));
  }
}

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

export interface CatalogueDeps {
  pool?: Pool | null;
  repo?: CatalogueRepository;
  verifyToken?: VerifyToken;
}

@Module({})
export class CatalogueHttpModule {
  static forRoot(deps: CatalogueDeps = {}): DynamicModule {
    const pool = deps.pool ?? null;
    const repo = deps.repo
      ?? (pool ? new PgCatalogueRepository(pool) : new InMemoryCatalogueRepository());
    const verify: VerifyToken = deps.verifyToken ?? (() => {
      throw new UnauthorizedError('token verification is not configured');
    });

    return {
      module: CatalogueHttpModule,
      imports: [HealthModule.forRoot(pool)],
      controllers: [DiscoveryController, ManagementController],
      providers: [
        { provide: CATALOGUE_REPO, useValue: repo },
        { provide: VERIFY_TOKEN, useValue: verify },
      ],
    };
  }
}
