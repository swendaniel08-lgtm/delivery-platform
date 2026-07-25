/**
 * Redis implementation of ClaimStore.
 *
 * `setNx` maps to SET key value NX PX ttl — a single atomic command.
 * This is what actually arbitrates the first-to-accept race across
 * multiple API instances (issue #7). Nothing else in the stack can.
 */

import type Redis from 'ioredis';
import type { ClaimStore } from './dispatch.ts';
import type { LatLng } from '../../../libs/maps/src/geohash.ts';

export class RedisClaimStore implements ClaimStore {
  constructor(private readonly redis: Redis) {}

  async setNx(key: string, value: string, ttlMs: number): Promise<boolean> {
    const res = await this.redis.set(key, value, 'PX', ttlMs, 'NX');
    return res === 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async geoAdd(key: string, member: string, p: LatLng): Promise<void> {
    await this.redis.geoadd(key, p.lng, p.lat, member);
  }

  async geoSearch(key: string, centre: LatLng, radiusMetres: number): Promise<string[]> {
    const res = await this.redis.call(
      'GEOSEARCH', key,
      'FROMLONLAT', String(centre.lng), String(centre.lat),
      'BYRADIUS', String(radiusMetres), 'm',
      'ASC',
    );
    return res as string[];
  }
}
