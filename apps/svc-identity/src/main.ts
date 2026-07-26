/**
 * identity-svc entrypoint.
 *
 * Composition root: the only file that reads the environment, opens sockets
 * or builds real providers. Everything below it takes its dependencies as
 * arguments, which is why the rest of the service is testable without a
 * database or an SMS account.
 *
 * Run: `npx tsx apps/svc-identity/src/main.ts`
 */

import 'reflect-metadata';
import { Pool } from 'pg';

import {
  createService, installShutdownHandlers, portFor,
} from '../../../libs/platform/src/service/bootstrap.ts';
import {
  smsConfigFrom, jwtFrom, infraFrom, describeConfig, ConfigError,
} from '../../../libs/platform/src/config/env.ts';
import {
  HubtelSmsProvider, ArkeselSmsProvider, FailoverSmsProvider, InMemorySmsProvider,
  type SmsProvider,
} from './sms/provider.ts';
import { IdentityHttpModule } from './http.ts';
import { PgUserRepository, PgSessionStore, RedisCounterStore } from './repository.ts';
import { InMemoryCounterStore, DEFAULT_OTP_LIMITS } from './otp/otp-service.ts';

const NAME = 'svc-identity';

async function main() {
  for (const line of describeConfig(NAME)) console.log(line);

  const infra = infraFrom();
  const jwt = jwtFrom();
  const sms = smsConfigFrom();

  /* ---- SMS ---------------------------------------------------------- */
  // Hubtel first, Arkesel as failover. Ghanaian SMS routes degrade
  // regularly and an undelivered OTP is a customer who cannot sign in at
  // all, so a second provider is worth the complexity.
  const providers: SmsProvider[] = [];
  if (sms.hubtel) providers.push(new HubtelSmsProvider(sms.hubtel));
  if (sms.arkesel) providers.push(new ArkeselSmsProvider(sms.arkesel));

  const smsProvider: SmsProvider = providers.length === 0
    ? new InMemorySmsProvider()
    : providers.length === 1
      ? providers[0]!
      : new FailoverSmsProvider(providers, (log) => {
          // Logged per attempt so a silent provider degradation is visible
          // in metrics before customers start complaining.
          console.log(`[${NAME}] sms attempt provider=${log.provider} ok=${log.ok}`
            + `${log.error ? ` error=${log.error}` : ''}`);
        });

  /* ---- Storage ------------------------------------------------------ */
  let pool: Pool | null = null;
  if (infra.databaseUrl) {
    pool = new Pool({
      connectionString: infra.databaseUrl,
      // Bounded so one service cannot exhaust Postgres' connection limit
      // and take every other service down with it.
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // Fail fast: a bad DATABASE_URL should stop the deploy, not surface as
    // a 500 on the first customer's login.
    await pool.query('SELECT 1');
    console.log(`[${NAME}] postgres connected`);
  } else {
    console.warn(`[${NAME}] WARNING: no DATABASE_URL — using in-memory storage. `
      + 'Sessions and accounts will be lost on restart.');
  }

  // OTP counters belong in Redis so rate limits hold across replicas. With
  // one process the in-memory store is equivalent; with two it is not, and
  // the limits become per-pod rather than global.
  const counters = infra.redisUrl
    ? await connectRedisCounters(infra.redisUrl)
    : new InMemoryCounterStore();
  if (!infra.redisUrl) {
    console.warn(`[${NAME}] WARNING: no REDIS_URL — OTP rate limits are PER-PROCESS. `
      + 'Do not run more than one replica like this.');
  }

  const svc = await createService({
    name: NAME,
    port: portFor(NAME),
    logger: true,
    ...(pool ? { pool } : {}),
    ...(infra.amqpUrl ? { amqpUrl: infra.amqpUrl } : {}),
    module: IdentityHttpModule.forRoot({
      pool,
      sms: smsProvider,
      counters,
      accessSecret: jwt.accessSecret,
      refreshSecret: jwt.refreshSecret,
      ...(pool ? { users: new PgUserRepository(pool), sessions: new PgSessionStore(pool) } : {}),
      // Never expose OTP codes over the API unless explicitly asked for in
      // a non-production environment.
      exposeCodeForTests: process.env.EXPOSE_OTP_CODES === 'true'
        && process.env.NODE_ENV !== 'production',
      // Integration suites sign in many users from one IP. Never honoured
      // in production, where the 20/hour ceiling is the SMS-spend defence.
      ...(process.env.OTP_RELAX_LIMITS === 'true'
        && process.env.NODE_ENV !== 'production'
        ? {
            otpLimits: {
              ...DEFAULT_OTP_LIMITS,
              perPhoneHour: 50, perPhoneDay: 200,
              perIpHour: 5_000, perDeviceHour: 5_000,
              resendCooldownSeconds: 0,
            },
          }
        : {}),
    }),
  });

  installShutdownHandlers(svc);
  console.log(`[${NAME}] listening on ${svc.url}`);
}

/** Lazily imported so `ioredis` is not a hard dependency for tests. */
async function connectRedisCounters(url: string) {
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(url, { maxRetriesPerRequest: 3 });
  await redis.ping();
  console.log(`[${NAME}] redis connected`);
  return new RedisCounterStore(redis as any);
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    // A configuration error is the operator's problem, not a crash: print
    // it plainly rather than burying it in a stack trace.
    console.error(`\n[${NAME}] CONFIGURATION ERROR\n  ${err.message}\n`);
    process.exit(78);   // EX_CONFIG
  }
  console.error(`[${NAME}] failed to start:`, err);
  process.exit(1);
});
