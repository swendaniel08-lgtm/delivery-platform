/**
 * messaging-svc entrypoint.
 *
 * This is the second place Hubtel credentials matter. identity-svc sends
 * OTPs; this service sends everything else — "your order is on the way",
 * "your rider has arrived".
 *
 * The distinction matters for cost: OTP volume tracks logins, notification
 * volume tracks order state changes, and there are roughly a dozen of those
 * per order. A template that quietly grows past 160 characters triples the
 * SMS bill for every delivery, which is why `smsSegments` is logged.
 *
 * Run: `npx tsx apps/svc-messaging/src/main.ts`
 */

import 'reflect-metadata';
import { Pool } from 'pg';

import {
  createService, installShutdownHandlers, portFor,
} from '../../../libs/platform/src/service/bootstrap.ts';
import {
  infraFrom, jwtFrom, smsConfigFrom, firebaseFrom, describeConfig, ConfigError,
  numberFrom,
} from '../../../libs/platform/src/config/env.ts';
import { verifyAccessToken } from '../../../libs/platform/src/auth/verify.ts';
import {
  HubtelSmsProvider, ArkeselSmsProvider, FailoverSmsProvider, InMemorySmsProvider,
  type SmsProvider,
} from '../../svc-identity/src/sms/provider.ts';
import { MessagingHttpModule } from './http.ts';
import {
  NotificationDispatcher, InMemoryPushProvider, InMemoryDedupeStore,
  type PushProvider,
} from './dispatcher.ts';
import { FcmPushProvider } from './push/fcm.ts';

const NAME = 'svc-messaging';

async function main() {
  for (const line of describeConfig(NAME)) console.log(line);

  const infra = infraFrom();
  const jwt = jwtFrom();
  const sms = smsConfigFrom();

  /* ---- SMS: same failover chain as identity-svc ---- */
  const providers: SmsProvider[] = [];
  if (sms.hubtel) providers.push(new HubtelSmsProvider(sms.hubtel));
  if (sms.arkesel) providers.push(new ArkeselSmsProvider(sms.arkesel));

  const smsProvider: SmsProvider = providers.length === 0
    ? new InMemorySmsProvider()
    : providers.length === 1
      ? providers[0]!
      : new FailoverSmsProvider(providers, (log) => {
          console.log(`[${NAME}] sms attempt provider=${log.provider} ok=${log.ok}`
            + `${log.error ? ` error=${log.error}` : ''}`);
        });

  let pool: Pool | null = null;
  if (infra.databaseUrl) {
    pool = new Pool({
      connectionString: infra.databaseUrl,
      max: numberFrom('PG_POOL_MAX', 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    await pool.query('SELECT 1');
    console.log(`[${NAME}] postgres connected`);
  } else {
    console.warn(`[${NAME}] WARNING: no DATABASE_URL — chat history is in memory `
      + 'and will be lost. Chat transcripts are dispute evidence.');
  }

  // Deduplication MUST be shared across replicas. With an in-memory store,
  // two replicas each see the same outbox event as new and the customer
  // gets two texts — and we pay for both.
  const dedupe = new InMemoryDedupeStore();
  if (!infra.redisUrl) {
    console.warn(`[${NAME}] WARNING: no REDIS_URL — notification dedupe is `
      + 'PER-PROCESS. Do not run more than one replica: customers will '
      + 'receive duplicate messages and we pay for each one.');
  }

  /* ---- Push ---- */
  const firebase = firebaseFrom();
  let pushProvider: PushProvider;
  if (firebase) {
    pushProvider = new FcmPushProvider({
      serviceAccount: {
        project_id: firebase.projectId,
        client_email: firebase.clientEmail,
        private_key: firebase.privateKey,
        token_uri: firebase.tokenUri,
      },
    });
    console.log(`[${NAME}] push: FCM project ${firebase.projectId}`);
  } else {
    pushProvider = new InMemoryPushProvider();
    console.warn(`[${NAME}] WARNING: no FIREBASE_SERVICE_ACCOUNT_JSON — push is a `
      + 'stub. Critical alerts still reach people by SMS, but we pay per '
      + 'message and routine status updates are silently dropped.');
  }

  /**
   * A dead token is the ONLY signal we ever get that an app was uninstalled.
   * Without pruning, that row is retried on every order of that customer's
   * life, forever.
   */
  const onDeadToken = async (token: string) => {
    if (!pool) return;
    // Soft revoke, not DELETE. `device_tokens_user_idx` is partial on
    // `revoked_at IS NULL`, so a revoked row costs nothing to skip, and
    // keeping it lets us tell "this user uninstalled" apart from "this user
    // never registered" when a delivery complaint comes in.
    const res = await pool.query(
      `UPDATE device_tokens SET revoked_at = now()
        WHERE token = $1 AND revoked_at IS NULL`,
      [token],
    );
    if (res.rowCount) console.log(`[${NAME}] revoked a dead push token`);
  };

  const dispatcher = new NotificationDispatcher(
    pushProvider,
    smsProvider,
    dedupe,
    { onDeadToken },
  );

  const svc = await createService({
    name: NAME,
    port: portFor(NAME),
    logger: true,
    ...(pool ? { pool } : {}),
    ...(infra.amqpUrl ? { amqpUrl: infra.amqpUrl } : {}),
    module: MessagingHttpModule.forRoot({
      pool,
      dispatcher,
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
