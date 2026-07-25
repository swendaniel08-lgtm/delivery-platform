/**
 * svc-dispatch entrypoint.
 *
 * Run: `npx tsx apps/svc-dispatch/src/main.ts`
 */

import 'reflect-metadata';
import { Pool } from 'pg';

import {
  createService, installShutdownHandlers, portFor,
} from '../../../libs/platform/src/service/bootstrap.ts';
import {
  infraFrom, jwtFrom, describeConfig, ConfigError,
} from '../../../libs/platform/src/config/env.ts';
import { verifyAccessToken } from '../../../libs/platform/src/auth/verify.ts';
import { DispatchHttpModule, PgRiderSource } from './http.ts';
import { RedisClaimStore } from './redis-claim-store.ts';
import { InMemoryClaimStore } from './dispatch.ts';

const NAME = 'svc-dispatch';

async function main() {
  for (const line of describeConfig(NAME)) console.log(line);

  const infra = infraFrom();
  const jwt = jwtFrom();

  let pool: Pool | null = null;
  if (infra.databaseUrl) {
    pool = new Pool({
      connectionString: infra.databaseUrl,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    await pool.query('SELECT 1');
    console.log(`[${NAME}] postgres connected`);
  } else {
    console.warn(`[${NAME}] WARNING: no DATABASE_URL — no rider candidates can be found. Dispatch will offer nothing.`);
  }

  // The claim store MUST be Redis in production. The in-memory one cannot
  // arbitrate between replicas, so two riders would each win the same leg
  // and both ride to the vendor.
  let claims;
  if (infra.redisUrl) {
    const { default: Redis } = await import('ioredis');
    const redis = new Redis(infra.redisUrl, { maxRetriesPerRequest: 3 });
    await redis.ping();
    console.log(`[${NAME}] redis connected`);
    claims = new RedisClaimStore(redis as any);
  } else {
    if (process.env.NODE_ENV === 'production') {
      throw new ConfigError(
        'REDIS_URL is required: without it the atomic accept claim cannot '
        + 'arbitrate between replicas and one order can be assigned twice.',
      );
    }
    console.warn(`[${NAME}] WARNING: no REDIS_URL — single-process claims only.`);
    claims = new InMemoryClaimStore();
  }

  const svc = await createService({
    name: NAME, port: portFor(NAME), logger: true,
    ...(pool ? { pool } : {}),
    ...(infra.amqpUrl ? { amqpUrl: infra.amqpUrl } : {}),
    module: DispatchHttpModule.forRoot({
      pool, claims,
      ...(pool ? { riderSource: new PgRiderSource(pool) } : {}),
      verifyToken: (token) => verifyAccessToken(token, jwt.accessSecret),
    }),
  });

  installShutdownHandlers(svc);
  console.log(`[${NAME}] listening on ${svc.url}`);
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(`\n[${NAME}] CONFIGURATION ERROR\n  ${err.message}\n`);
    process.exit(78);
  }
  console.error(`[${NAME}] failed to start:`, err);
  process.exit(1);
});
