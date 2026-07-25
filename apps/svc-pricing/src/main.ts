/**
 * svc-pricing entrypoint.
 *
 * Run: `npx tsx apps/svc-pricing/src/main.ts`
 */

import 'reflect-metadata';

import {
  createService, installShutdownHandlers, portFor,
} from '../../../libs/platform/src/service/bootstrap.ts';
import {
  infraFrom, jwtFrom, describeConfig, ConfigError,
} from '../../../libs/platform/src/config/env.ts';
import { verifyAccessToken } from '../../../libs/platform/src/auth/verify.ts';
import { PricingHttpModule } from './http.ts';

const NAME = 'svc-pricing';

async function main() {
  for (const line of describeConfig(NAME)) console.log(line);

  const infra = infraFrom();
  const jwt = jwtFrom();

  // Pricing is a pure calculator: no database, no events, no secrets.
  const svc = await createService({
    name: NAME, port: portFor(NAME), logger: true,
    module: PricingHttpModule,
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
