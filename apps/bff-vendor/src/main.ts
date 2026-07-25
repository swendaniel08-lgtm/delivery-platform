/**
 * bff-vendor entrypoint.
 *
 * A BFF owns no data. It fans out to services and shapes the result for one
 * app, so the only thing it needs from the environment is where those
 * services live and how to verify a user's token.
 *
 * Run: `npx tsx apps/bff-vendor/src/main.ts`
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
import { VendorBffHttpModule } from './http.ts';

const NAME = 'bff-vendor';

async function main() {
  for (const line of describeConfig(NAME)) console.log(line);

  const jwt = jwtFrom();

  // One shared timeout budget. A BFF answers a phone on a slow network, so
  // it must give up on an upstream long before the handset does.
  const timeoutMs = numberFrom('UPSTREAM_TIMEOUT_MS', 3_000);
  const c = (name: string, envKey: string, port: number) => new ServiceClient({
    name,
    baseUrl: optional(envKey, `http://127.0.0.1:${port}`),
    defaultTimeoutMs: timeoutMs,
  });

  const svc = await createService({
    name: NAME,
    port: portFor(NAME),
    logger: true,
    module: VendorBffHttpModule.forRoot({
      verifyToken: (token) => verifyAccessToken(token, jwt.accessSecret),
      upstreams: {
        order: c('svc-order', 'SVC_ORDER_URL', 3003),
        catalogue: c('svc-catalogue', 'SVC_CATALOGUE_URL', 3002),
        payment: c('svc-payment', 'SVC_PAYMENT_URL', 3007),
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
