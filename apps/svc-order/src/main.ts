/**
 * order-svc entrypoint.
 *
 * The order service is the only one that MUST have a database: an order is
 * a promise to a customer who has been charged, and an in-memory order is a
 * promise that vanishes on the next deploy.
 *
 * It also runs the durable timer worker, which is what turns "the vendor
 * has 3 minutes to accept" from a `setTimeout` into a guarantee that
 * survives a restart.
 *
 * Run: `npx tsx apps/svc-order/src/main.ts`
 */

import 'reflect-metadata';
import { Pool } from 'pg';

import {
  createService, installShutdownHandlers, portFor,
} from '../../../libs/platform/src/service/bootstrap.ts';
import {
  infraFrom, describeConfig, ConfigError, isProduction, numberFrom, boolFrom,
} from '../../../libs/platform/src/config/env.ts';
import { OrderModule, OrderService } from './http/order.module.ts';
import { TimerWorker } from './timers/worker.ts';

const NAME = 'svc-order';

async function main() {
  for (const line of describeConfig(NAME)) console.log(line);

  const infra = infraFrom();

  if (!infra.databaseUrl) {
    // Deliberately fatal in EVERY environment, not just production. Every
    // other service degrades to memory usefully; this one cannot, because
    // the order table is the record of what customers are owed.
    throw new ConfigError(
      'DATABASE_URL is required. An order is a promise to a customer who has '
      + 'already been charged — it cannot live in memory.',
    );
  }

  const pool = new Pool({
    connectionString: infra.databaseUrl,
    max: numberFrom('PG_POOL_MAX', 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  await pool.query('SELECT 1');
  console.log(`[${NAME}] postgres connected`);

  if (!infra.amqpUrl) {
    console.warn(`[${NAME}] WARNING: no RABBITMQ_URL — the outbox will fill up `
      + 'and no other service will hear about state changes. Dispatch will '
      + 'never be told an order is ready.');
  }

  const svc = await createService({
    name: NAME,
    port: portFor(NAME),
    logger: true,
    pool,
    ...(infra.amqpUrl ? { amqpUrl: infra.amqpUrl } : {}),
    module: OrderModule.forRoot(pool),
  });

  /* ---- durable timers ---- */
  // Resolved from the running app so the worker uses the same service (and
  // therefore the same transactional guarantees) as the HTTP handlers.
  const orders = svc.app.get<OrderService>(
    // The provider token is the ORDER_SERVICE symbol exported by the module.
    (await import('./http/order.module.ts')).ORDER_SERVICE,
  );

  const worker = new TimerWorker(
    pool,
    (orderId, event, actor) => orders.apply(orderId, event as any, actor),
    {
      intervalMs: numberFrom('TIMER_POLL_MS', 1_000),
      batchSize: numberFrom('TIMER_BATCH_SIZE', 20),
      onError: (e) => console.error(`[${NAME}] timer error:`, e.message),
      onFired: (t, outcome) => {
        // 'stale' is normal and frequent: it means the vendor accepted just
        // before their deadline. Logged at debug volume, not as an error.
        if (outcome !== 'stale') {
          console.log(`[${NAME}] timer ${t.name} order=${t.order_id} -> ${outcome}`);
        }
      },
    },
  );

  if (boolFrom('RUN_TIMER_WORKER', true)) {
    worker.start();
    console.log(`[${NAME}] timer worker started `
      + '(FOR UPDATE SKIP LOCKED — safe to run on every replica)');
  } else {
    console.warn(`[${NAME}] timer worker DISABLED — deadlines will never fire.`);
  }

  const originalStop = svc.stop;
  svc.stop = async () => {
    // Stop claiming new timers before the pool closes, or an in-flight
    // batch throws on a dead connection during shutdown.
    worker.stop();
    await originalStop();
    await pool.end().catch(() => {});
  };

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
