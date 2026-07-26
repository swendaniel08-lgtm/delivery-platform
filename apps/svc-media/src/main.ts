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
  infraFrom, jwtFrom, s3From, describeConfig, ConfigError,
  numberFrom, isProduction,
} from '../../../libs/platform/src/config/env.ts';
import { verifyAccessToken } from '../../../libs/platform/src/auth/verify.ts';
import { MediaHttpModule } from './http.ts';
import { InMemoryStorage, type StoragePort } from './media.ts';
import { S3Storage } from './storage/s3.ts';

const NAME = 'svc-media';

async function main() {
  for (const line of describeConfig(NAME)) console.log(line);

  const infra = infraFrom();
  const jwt = jwtFrom();

  // s3From() throws in production when storage is absent or half-configured,
  // so this branch can only be taken on a developer's machine.
  const s3 = s3From();
  let storage: StoragePort;
  if (s3) {
    storage = new S3Storage({
      endpoint: s3.endpoint,
      bucket: s3.bucket,
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
      region: s3.region,
      ...(s3.forcePathStyle === undefined ? {} : { forcePathStyle: s3.forcePathStyle }),
      ...(s3.publicBaseUrl ? { publicBaseUrl: s3.publicBaseUrl } : {}),
    });
    // PREFLIGHT. A service that boots healthy against a bucket that does not
    // exist fails as a 404 on a rider's phone at the end of a delivery. Find
    // out here instead, where the log is being read.
    const store = storage as S3Storage;
    const exists = await store.bucketExists().catch((e: Error) => {
      throw new ConfigError(
        `object storage is unreachable: ${e.message}. Check S3_ENDPOINT, the `
        + 'credentials, and S3_FORCE_PATH_STYLE (MinIO and most self-hosted '
        + 'gateways need it true).',
      );
    });
    if (!exists) {
      if (isProduction()) {
        // Auto-creating in production would make a typo in S3_BUCKET silently
        // succeed into an empty bucket with no lifecycle or access policy.
        throw new ConfigError(
          `bucket "${s3.bucket}" does not exist at ${new URL(s3.endpoint).host}. `
          + 'Create it with its retention and block-public-access policies before '
          + 'starting; media-svc will not create production buckets itself.',
        );
      }
      await store.ensureBucket();
      console.warn(`[${NAME}] created missing dev bucket "${s3.bucket}"`);
    }
    console.log(`[${NAME}] object storage OK: ${s3.bucket} @ ${new URL(s3.endpoint).host}`);
  } else {
    storage = new InMemoryStorage();
    console.warn(`[${NAME}] WARNING: no S3_ENDPOINT — using in-memory storage. `
      + 'Uploaded objects are DISCARDED. Proof of delivery will not survive.');
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
      storage,
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
