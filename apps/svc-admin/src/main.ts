/**
 * admin-svc entrypoint.
 *
 * Refuses to start without a database in production, for one reason: the
 * audit log. An admin console that cannot record who refunded what is worse
 * than no console — it invites actions nobody can later account for.
 *
 * Run: `npx tsx apps/svc-admin/src/main.ts`
 */

import 'reflect-metadata';
import { Pool } from 'pg';

import {
  createService, installShutdownHandlers, portFor,
} from '../../../libs/platform/src/service/bootstrap.ts';
import {
  infraFrom, jwtFrom, describeConfig, ConfigError, isProduction, numberFrom,
} from '../../../libs/platform/src/config/env.ts';
import { verifyAccessToken } from '../../../libs/platform/src/auth/verify.ts';
import { AdminHttpModule } from './http.ts';

const NAME = 'svc-admin';

async function main() {
  for (const line of describeConfig(NAME)) console.log(line);

  const infra = infraFrom();
  const jwt = jwtFrom();

  let pool: Pool | null = null;
  if (infra.databaseUrl) {
    pool = new Pool({
      connectionString: infra.databaseUrl,
      max: numberFrom('PG_POOL_MAX', 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    await pool.query('SELECT 1');
    console.log(`[${NAME}] postgres connected — audit log is durable`);
  } else if (isProduction()) {
    throw new ConfigError(
      'DATABASE_URL is required. Without it the audit log is in memory, so '
      + 'every refund and suspension would be unaccountable after a restart.',
    );
  } else {
    console.warn(`[${NAME}] WARNING: no DATABASE_URL — the audit log is IN MEMORY `
      + 'and will be lost on restart.');
  }

  const svc = await createService({
    name: NAME,
    port: portFor(NAME),
    logger: true,
    ...(pool ? { pool } : {}),
    ...(infra.amqpUrl ? { amqpUrl: infra.amqpUrl } : {}),
    module: AdminHttpModule.forRoot({
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
