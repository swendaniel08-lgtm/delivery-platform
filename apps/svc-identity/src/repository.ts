/**
 * identity-svc persistence.
 *
 * Two implementations of every port: Postgres for production, in-memory for
 * unit tests. The in-memory ones are not toys — the HTTP specs run against
 * them, so their semantics (unique phone, one default address per user,
 * session rotation) must match the SQL constraints in 001_identity.sql.
 */

import type { Pool } from 'pg';
import { ConflictError, NotFoundError } from '../../../libs/platform/src/errors.ts';
import type { SessionStore } from './token/token-service.ts';
import type { Role } from './token/token-service.ts';

export interface UserRow {
  id: string;
  phone: string;
  email: string | null;
  role: Role;
  first_name: string | null;
  last_name: string | null;
  phone_verified: boolean;
  status: 'active' | 'suspended' | 'pending_review' | 'rejected' | 'deleted';
  created_at: string;
}

export interface AddressRow {
  id: string;
  user_id: string;
  label: string;
  latitude: number;
  longitude: number;
  ghanapost_address: string | null;
  area_name: string | null;
  landmark: string | null;
  delivery_instructions: string | null;
  contact_phone: string | null;
  is_default: boolean;
}

export interface AddressInput {
  label?: string;
  latitude: number;
  longitude: number;
  ghanapostAddress?: string | null;
  areaName?: string | null;
  landmark?: string | null;
  deliveryInstructions?: string | null;
  contactPhone?: string | null;
  isDefault?: boolean;
}

export interface UserRepository {
  findByPhone(phone: string): Promise<UserRow | null>;
  findById(id: string): Promise<UserRow | null>;
  /** Idempotent: an OTP login for an unknown phone creates the account. */
  upsertVerified(phone: string, role: Role): Promise<UserRow>;
  updateProfile(id: string, patch: {
    firstName?: string; lastName?: string; email?: string | null;
  }): Promise<UserRow>;

  listAddresses(userId: string): Promise<AddressRow[]>;
  addAddress(userId: string, input: AddressInput): Promise<AddressRow>;
  deleteAddress(userId: string, addressId: string): Promise<void>;
  setDefaultAddress(userId: string, addressId: string): Promise<AddressRow>;
}

/* ------------------------------------------------------------------ */
/* In-memory                                                           */
/* ------------------------------------------------------------------ */

let counter = 0;
const uuid = (): string => {
  counter += 1;
  const hex = counter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
};

export class InMemoryUserRepository implements UserRepository {
  users = new Map<string, UserRow>();
  addresses = new Map<string, AddressRow>();

  async findByPhone(phone: string) {
    for (const u of this.users.values()) if (u.phone === phone) return { ...u };
    return null;
  }
  async findById(id: string) {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }
  async upsertVerified(phone: string, role: Role) {
    const existing = await this.findByPhone(phone);
    if (existing) {
      // A phone belongs to exactly one role. Signing in as a rider with a
      // customer's number must fail loudly rather than silently escalate.
      if (existing.role !== role) {
        throw new ConflictError(`This number is already registered as a ${existing.role}`);
      }
      const row = this.users.get(existing.id)!;
      row.phone_verified = true;
      return { ...row };
    }
    const row: UserRow = {
      id: uuid(), phone, email: null, role,
      first_name: null, last_name: null,
      phone_verified: true, status: 'active',
      created_at: new Date().toISOString(),
    };
    this.users.set(row.id, row);
    return { ...row };
  }
  async updateProfile(id: string, patch: { firstName?: string; lastName?: string; email?: string | null }) {
    const row = this.users.get(id);
    if (!row) throw new NotFoundError('User');
    if (patch.firstName !== undefined) row.first_name = patch.firstName;
    if (patch.lastName !== undefined) row.last_name = patch.lastName;
    if (patch.email !== undefined) row.email = patch.email;
    return { ...row };
  }

  async listAddresses(userId: string) {
    return [...this.addresses.values()]
      .filter((a) => a.user_id === userId)
      .sort((a, b) => Number(b.is_default) - Number(a.is_default));
  }
  async addAddress(userId: string, input: AddressInput) {
    const mine = await this.listAddresses(userId);
    // First address is always the default, whatever the client says.
    const isDefault = input.isDefault === true || mine.length === 0;
    if (isDefault) for (const a of this.addresses.values()) {
      if (a.user_id === userId) a.is_default = false;
    }
    const row: AddressRow = {
      id: uuid(), user_id: userId,
      label: input.label ?? 'Home',
      latitude: input.latitude, longitude: input.longitude,
      ghanapost_address: input.ghanapostAddress ?? null,
      area_name: input.areaName ?? null,
      landmark: input.landmark ?? null,
      delivery_instructions: input.deliveryInstructions ?? null,
      contact_phone: input.contactPhone ?? null,
      is_default: isDefault,
    };
    this.addresses.set(row.id, row);
    return { ...row };
  }
  async deleteAddress(userId: string, addressId: string) {
    const row = this.addresses.get(addressId);
    if (!row || row.user_id !== userId) throw new NotFoundError('Address');
    this.addresses.delete(addressId);
    // Never leave a user with addresses but no default.
    if (row.is_default) {
      const next = (await this.listAddresses(userId))[0];
      if (next) this.addresses.get(next.id)!.is_default = true;
    }
  }
  async setDefaultAddress(userId: string, addressId: string) {
    const row = this.addresses.get(addressId);
    if (!row || row.user_id !== userId) throw new NotFoundError('Address');
    for (const a of this.addresses.values()) if (a.user_id === userId) a.is_default = false;
    row.is_default = true;
    return { ...row };
  }
}

/* ------------------------------------------------------------------ */
/* Postgres                                                            */
/* ------------------------------------------------------------------ */

export class PgUserRepository implements UserRepository {
  constructor(private readonly pool: Pool) {}

  async findByPhone(phone: string) {
    const r = await this.pool.query<UserRow>('SELECT * FROM users WHERE phone = $1', [phone]);
    return r.rows[0] ?? null;
  }
  async findById(id: string) {
    const r = await this.pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return r.rows[0] ?? null;
  }

  async upsertVerified(phone: string, role: Role) {
    const existing = await this.findByPhone(phone);
    if (existing) {
      if (existing.role !== role) {
        throw new ConflictError(`This number is already registered as a ${existing.role}`);
      }
      const r = await this.pool.query<UserRow>(
        `UPDATE users SET phone_verified = true WHERE id = $1 RETURNING *`, [existing.id],
      );
      return r.rows[0]!;
    }
    // ON CONFLICT rather than a bare INSERT: two devices can verify the same
    // number in the same millisecond and only one may win the unique index.
    const r = await this.pool.query<UserRow>(
      `INSERT INTO users (phone, role, phone_verified)
       VALUES ($1, $2, true)
       ON CONFLICT (phone) DO UPDATE SET phone_verified = true
       RETURNING *`,
      [phone, role],
    );
    return r.rows[0]!;
  }

  async updateProfile(id: string, patch: { firstName?: string; lastName?: string; email?: string | null }) {
    const r = await this.pool.query<UserRow>(
      `UPDATE users SET
         first_name = COALESCE($2, first_name),
         last_name  = COALESCE($3, last_name),
         email      = COALESCE($4, email)
       WHERE id = $1 RETURNING *`,
      [id, patch.firstName ?? null, patch.lastName ?? null, patch.email ?? null],
    );
    const row = r.rows[0];
    if (!row) throw new NotFoundError('User');
    return row;
  }

  async listAddresses(userId: string) {
    const r = await this.pool.query<AddressRow>(
      `SELECT * FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at`, [userId],
    );
    return r.rows;
  }

  async addAddress(userId: string, input: AddressInput) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const count = await client.query<{ n: string }>(
        'SELECT count(*) AS n FROM addresses WHERE user_id = $1', [userId],
      );
      const isDefault = input.isDefault === true || count.rows[0]!.n === '0';
      if (isDefault) {
        // The partial unique index allows one default; clear it first.
        await client.query(
          'UPDATE addresses SET is_default = false WHERE user_id = $1 AND is_default', [userId],
        );
      }
      const r = await client.query<AddressRow>(
        `INSERT INTO addresses
           (user_id, label, latitude, longitude, ghanapost_address, area_name,
            landmark, delivery_instructions, contact_phone, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [userId, input.label ?? 'Home', input.latitude, input.longitude,
          input.ghanapostAddress ?? null, input.areaName ?? null, input.landmark ?? null,
          input.deliveryInstructions ?? null, input.contactPhone ?? null, isDefault],
      );
      await client.query('COMMIT');
      return r.rows[0]!;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async deleteAddress(userId: string, addressId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query<AddressRow>(
        'DELETE FROM addresses WHERE id = $1 AND user_id = $2 RETURNING *', [addressId, userId],
      );
      const row = r.rows[0];
      if (!row) throw new NotFoundError('Address');
      if (row.is_default) {
        await client.query(
          `UPDATE addresses SET is_default = true
             WHERE id = (SELECT id FROM addresses WHERE user_id = $1
                         ORDER BY created_at LIMIT 1)`,
          [userId],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async setDefaultAddress(userId: string, addressId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE addresses SET is_default = false WHERE user_id = $1 AND is_default', [userId],
      );
      const r = await client.query<AddressRow>(
        'UPDATE addresses SET is_default = true WHERE id = $1 AND user_id = $2 RETURNING *',
        [addressId, userId],
      );
      const row = r.rows[0];
      if (!row) throw new NotFoundError('Address');
      await client.query('COMMIT');
      return row;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
}

/** Postgres-backed session store for refresh-token rotation. */
export class PgSessionStore implements SessionStore {
  constructor(private readonly pool: Pool) {}

  async create(row: {
    id: string; userId: string; refreshTokenHash: string; deviceId?: string; expiresAt: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, device_id, expires_at)
       VALUES ($1,$2,$3,$4,to_timestamp($5 / 1000.0))`,
      [row.id, row.userId, row.refreshTokenHash, row.deviceId ?? null, row.expiresAt],
    );
  }

  async findByHash(hash: string) {
    const r = await this.pool.query<{
      id: string; user_id: string; expires_at: Date;
      revoked_at: Date | null; replaced_by: string | null;
    }>('SELECT * FROM sessions WHERE refresh_token_hash = $1', [hash]);
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      expiresAt: new Date(row.expires_at).getTime(),
      revokedAt: row.revoked_at ? new Date(row.revoked_at).getTime() : null,
      replacedBy: row.replaced_by,
    };
  }

  async markReplaced(id: string, replacedBy: string): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET replaced_by = $2, revoked_at = now() WHERE id = $1', [id, replacedBy],
    );
  }

  async revokeAllForUser(userId: string, _reason: string): Promise<number> {
    const r = await this.pool.query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId],
    );
    return r.rowCount ?? 0;
  }
}

/** Redis-backed counter store for OTP limits (port defined in otp-service). */
export interface RedisLike {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  ttl(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export class RedisCounterStore {
  constructor(private readonly redis: RedisLike) {}
  async incr(key: string, ttlSeconds: number): Promise<number> {
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, ttlSeconds);
    return n;
  }
  async ttl(key: string): Promise<number> {
    const t = await this.redis.ttl(key);
    return t > 0 ? t : 0;
  }
  async get(key: string): Promise<string | null> { return this.redis.get(key); }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }
  async del(key: string): Promise<void> { await this.redis.del(key); }
}
