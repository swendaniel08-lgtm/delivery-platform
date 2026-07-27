/**
 * payment-svc entrypoint.
 *
 * This is the process that touches real money, so it is the strictest:
 *
 *   • No Postgres → refuse to start. An in-memory ledger would accept
 *     settlements and lose them on restart, and there is no way to
 *     reconstruct who was paid what.
 *   • No Paystack webhook secret → no webhook route is mounted at all. An
 *     unsigned payment webhook is worse than none: anyone who finds the URL
 *     could mark orders paid.
 *
 * Run: `npx tsx apps/svc-payment/src/main.ts`
 */

import 'reflect-metadata';
import { Pool } from 'pg';

import {
  createService, installShutdownHandlers, portFor,
} from '../../../libs/platform/src/service/bootstrap.ts';
import {
  infraFrom, jwtFrom, paystackFrom, describeConfig, ConfigError, isProduction,
} from '../../../libs/platform/src/config/env.ts';
import { verifyAccessToken } from '../../../libs/platform/src/auth/verify.ts';
import { PaymentHttpModule } from './http.ts';
import { LedgerService } from './ledger.ts';
import { PgLedgerRepository } from './pg-ledger-repository.ts';
import { InMemoryLedgerRepository } from './memory-ledger-repository.ts';
import {
  PaystackWebhookProcessor, InMemoryWebhookStore, type WebhookHandlers,
} from './paystack/webhook.ts';
import { PaystackClient, HttpPaystackTransport, orderIdFromReference,
} from './paystack/client.ts';

const NAME = 'svc-payment';

async function main() {
  for (const line of describeConfig(NAME)) console.log(line);

  const infra = infraFrom();
  const jwt = jwtFrom();
  const paystack = paystackFrom();

  /* ---- Ledger ------------------------------------------------------- */
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
  } else if (isProduction()) {
    throw new ConfigError(
      'DATABASE_URL is required. The ledger is the record of who is owed '
      + 'what; an in-memory ledger silently loses every settlement on restart.',
    );
  } else {
    console.warn(`[${NAME}] WARNING: no DATABASE_URL — the ledger is IN MEMORY. `
      + 'Balances reset on restart. Never do this outside local development.');
  }

  const ledger = new LedgerService(
    pool ? new PgLedgerRepository(pool) : new InMemoryLedgerRepository(),
  );

  /* ---- Paystack --------------------------------------------------- */
  // The client INITIATES charges; the webhook CONFIRMS them. Two different
  // directions, and only the second one is allowed to move money.
  const paystackClient = paystack
    ? new PaystackClient(new HttpPaystackTransport(paystack.secretKey))
    : null;

  let processor: PaystackWebhookProcessor | undefined;
  if (paystack) {
    // These handlers are where a confirmed payment becomes ledger movement.
    // Everything is keyed on the Paystack reference, which we mint as
    // `order:<id>:capture`, so a replay is idempotent at the ledger level.
    const handlers: WebhookHandlers = {
      async onChargeSuccess({ reference, amount, feePesewas }) {
        const orderId = orderIdFrom(reference);
        if (!orderId) {
          console.warn(`[${NAME}] charge.success for unrecognised reference ${reference}`);
          return;
        }
        await ledger.capture(orderId, amount);
        // Paystack's cut is a real cost and is booked, never netted away.
        if (feePesewas > 0n) await ledger.pspFee(orderId, feePesewas);
        console.log(`[${NAME}] captured order=${orderId} amount=${amount}`);
      },
      async onRefundStateChange({ reference, status }) {
        console.log(`[${NAME}] refund ${reference} -> ${status}`);
      },
      async onTransferSettled({ reference, status }) {
        // A failed payout must be reversed, or a rider's balance stays
        // debited for money that never left the platform.
        console.log(`[${NAME}] transfer ${reference} -> ${status}`);
      },
      async onDispute({ reference, event }) {
        console.warn(`[${NAME}] DISPUTE ${event} on ${reference} — needs an admin`);
      },
    };

    processor = new PaystackWebhookProcessor(
      paystack.webhookSecret,
      new InMemoryWebhookStore(),
      handlers,
    );
    console.log(`[${NAME}] Paystack webhook mounted `
      + `(${paystack.isTestMode ? 'TEST' : 'LIVE'} mode)`);
  } else {
    console.warn(`[${NAME}] WARNING: no PAYSTACK_SECRET_KEY — the webhook route `
      + 'is NOT mounted. Payments cannot be confirmed.');
  }

  const svc = await createService({
    name: NAME,
    port: portFor(NAME),
    logger: true,
    ...(pool ? { pool } : {}),
    ...(infra.amqpUrl ? { amqpUrl: infra.amqpUrl } : {}),
    // Paystack signs the LITERAL bytes it sent; re-serialising breaks it.
    rawBodyRoutes: ['/payments/webhooks'],
    module: PaymentHttpModule.forRoot({
      pool,
      ledger,
      ...(processor ? { processor } : {}),
      paystack: paystackClient,
      verifyToken: (token) => verifyAccessToken(token, jwt.accessSecret),
    }),
  });

  installShutdownHandlers(svc);
  console.log(`[${NAME}] listening on ${svc.url}`);
}

/** `order:<uuid>:capture` → `<uuid>`. Returns null for anything else. */
/**
 * Delegates to the inverse of `chargeReference`.
 *
 * This used to carry its own regex for a format the client never produced.
 * Keeping the pair in one file is the point: a reference scheme with two
 * independent definitions will drift, and the failure is silent — money
 * taken and never captured.
 */
function orderIdFrom(reference: string): string | null {
  return orderIdFromReference(reference);
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(`\n[${NAME}] CONFIGURATION ERROR\n  ${err.message}\n`);
    process.exit(78);
  }
  console.error(`[${NAME}] failed to start:`, err);
  process.exit(1);
});
