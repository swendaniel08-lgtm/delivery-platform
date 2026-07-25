/**
 * media-svc entrypoint.
 *
 * Bytes go straight from the phone to object storage; this service only
 * issues presigned URLs. That keeps a 6MB Ghana Card scan out of Node's
 * heap and off our egress bill.
 *
 * Run: `npx tsx apps/svc-media/src/main.ts`
 */

import 'reflect-metadata';
import { Pool } from 'pg';

import {
  createService, installShutdownHandlers, portFor,
} from '../../../libs/platform/src/service/bootstrap.ts';
import {
  infraFrom, jwtFrom, optionalOrNull, describeConfig, ConfigError,
  isProduction, numberFrom,
} from '../../../libs/platform/src/config/env.ts';
import { verifyAccessToken } from '../../../libs/platform/src/auth/verify.ts';
import { MediaHttpModule } from './http.ts';
import { InMemoryStorage } from './media.ts';

const NAME = 'svc-media';

async function main() {
  for (const line of describeConfig(NAME)) console.log(line);

  const infra = infraFrom();
  const jwt = jwtFrom();

  const s3Endpoint = optionalOrNull('S3_ENDPOINT');
  if (!s3Endpoint) {
    if (isProduction()) {
      throw new ConfigError(
        'S3_ENDPOINT is required. Without object storage, KYC documents and '
        + 'proof-of-delivery photos have nowhere to live — and a delivery '
        + 'dispute with no photo is unarguable.',
      );
    }
    console.warn(`[${NAME}] WARNING: no S3_ENDPOINT — using in-memory storage. `
      + 'Uploaded objects are discarded.');
  }

  let pool: Pool | null = null;
  if (infra.databaseUrl) {
    pool = new Pool({
      connectionString: infra.databaseUrl,
      max: numberFrom('PG_POOL_MAX', 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    await pool.query('SELECT 1');
    console.log(`[${NAME}] postgres connected`);
  }

  const svc = await createService({
    name: NAME,
    port: portFor(NAME),
    logger: true,
    ...(pool ? { pool } : {}),
    module: MediaHttpModule.forRoot({
      pool,
      // The real S3 adapter lands with the storage credentials; the port is
      // already defined so swapping it is a one-line change here.
      storage: new InMemoryStorage(),
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
