/**
 * svc-tracking entrypoint.
 *
 * Run: `npx tsx apps/svc-tracking/src/main.ts`
 */

import 'reflect-metadata';
import { Pool } from 'pg';

import {
  createService, installShutdownHandlers, portFor,
} from '../../../libs/platform/src/service/bootstrap.ts';
import {
  infraFrom, jwtFrom, describeConfig, ConfigError, isProduction,
} from '../../../libs/platform/src/config/env.ts';
import { verifyAccessToken } from '../../../libs/platform/src/auth/verify.ts';
import { TrackingHttpModule } from './http.ts';

const NAME = 'svc-tracking';

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

    // PostGIS is not optional here. Every fence check and every distance is
    // ST_DWithin on a GEOGRAPHY column; without the extension the service
    // starts and then fails on the first ping, which is the worst possible
    // moment to find out.
    const { rows } = await pool.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS ok`,
    );
    if (!rows[0]?.ok) {
      throw new ConfigError(
        'PostGIS is not installed on this database. tracking-svc stores rider '
        + 'positions as GEOGRAPHY and computes geofences with ST_DWithin. '
        + 'Run: CREATE EXTENSION postgis;  (image: postgis/postgis:16-3.4)',
      );
    }
    console.log(`[${NAME}] postgres connected (PostGIS present) — tracks persist`);
  } else {
    if (isProduction()) {
      // The breadcrumb trail IS the evidence in a "the rider never came"
      // dispute, and rejected pings are the only fraud signal we collect.
      // Losing both on every deploy is not something to warn about.
      throw new ConfigError(
        'DATABASE_URL is required in production. Without it rider breadcrumb '
        + 'trails and mock-location fraud signals are held in memory and lost '
        + 'on every restart — a delivery dispute would have no evidence.',
      );
    }
    console.warn(`[${NAME}] WARNING: no DATABASE_URL — rider tracks are in memory and lost on restart.`);
  }

  const svc = await createService({
    name: NAME, port: portFor(NAME), logger: true,
    ...(pool ? { pool } : {}),
    ...(infra.amqpUrl ? { amqpUrl: infra.amqpUrl } : {}),
    module: TrackingHttpModule.forRoot({
      pool,
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
