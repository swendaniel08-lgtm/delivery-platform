/**
 * bff-admin entrypoint.
 *
 * Run: `npx tsx apps/bff-admin/src/main.ts`
 */

import 'reflect-metadata';

import {
  createService, installShutdownHandlers, portFor,
} from '../../../libs/platform/src/service/bootstrap.ts';
import {
  jwtFrom, optional, numberFrom, describeConfig, ConfigError,
} from '../../../libs/platform/src/config/env.ts';
import { ServiceClient } from '../../../libs/platform/src/http/service-client.ts';
import { verifyAccessToken } from '../../../libs/platform/src/auth/verify.ts';
import { AdminBffHttpModule } from './http.ts';

const NAME = 'bff-admin';

async function main() {
  for (const line of describeConfig(NAME)) console.log(line);

  const jwt = jwtFrom();
  // Operators tolerate a slower screen better than a wrong one, so this
  // budget is more generous than the customer-facing BFFs.
  const timeoutMs = numberFrom('UPSTREAM_TIMEOUT_MS', 5_000);
  const c = (name: string, envKey: string, port: number) => new ServiceClient({
    name,
    baseUrl: optional(envKey, `http://127.0.0.1:${port}`),
    defaultTimeoutMs: timeoutMs,
  });

  const svc = await createService({
    name: NAME,
    port: portFor(NAME),
    logger: true,
    module: AdminBffHttpModule.forRoot({
      verifyToken: (token) => verifyAccessToken(token, jwt.accessSecret),
      upstreams: {
        admin: c('svc-admin', 'SVC_ADMIN_URL', 3010),
        order: c('svc-order', 'SVC_ORDER_URL', 3003),
        payment: c('svc-payment', 'SVC_PAYMENT_URL', 3007),
        catalogue: c('svc-catalogue', 'SVC_CATALOGUE_URL', 3002),
        identity: c('svc-identity', 'SVC_IDENTITY_URL', 3001),
      },
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
