/**
 * Shared service bootstrap.
 *
 * Every Besonc service needs the same nine things: Fastify, the RFC-7807
 * filter, correlation IDs, health and readiness probes, graceful shutdown,
 * a pg pool, the outbox relay, structured logs and a port from the
 * environment. Writing that ten times guarantees ten subtly different
 * versions, so it lives here once.
 *
 * `createService()` returns a running app; the caller supplies only its own
 * domain module.
 */

import 'reflect-metadata';
import { Controller, Get, Module, Inject, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';

import { ProblemDetailsFilter, CorrelationMiddleware } from '../http/problem-filter.ts';
import { OutboxRelay, RelayRunner } from '../outbox/relay.ts';
import { AmqpPublisher } from '../outbox/amqp.ts';

export const PG_POOL = Symbol('PG_POOL');
export const SERVICE_NAME = Symbol('SERVICE_NAME');

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

export interface HealthState {
  serviceName: string;
  startedAt: Date;
  /** Flipped false during shutdown so the load balancer drains us first. */
  accepting: boolean;
}

export const health: HealthState = {
  serviceName: 'unknown', startedAt: new Date(), accepting: true,
};

@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool | null) {}

  /**
   * Liveness: is the process alive? Deliberately does NOT touch the database.
   * A liveness probe that checks dependencies causes a DB blip to restart
   * every pod simultaneously, turning a slow query into an outage.
   */
  @Get()
  live() {
    return {
      status: 'ok',
      service: health.serviceName,
      uptimeSeconds: Math.floor((Date.now() - health.startedAt.getTime()) / 1000),
    };
  }

  /** Readiness: should traffic be routed here? This one DOES check deps. */
  @Get('ready')
  async ready() {
    if (!health.accepting) {
      return { status: 'draining', service: health.serviceName };
    }
    if (this.pool) await this.pool.query('SELECT 1');
    return { status: 'ready', service: health.serviceName };
  }
}

@Module({})
export class HealthModule {
  static forRoot(pool: Pool | null): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [{ provide: PG_POOL, useValue: pool }],
      exports: [PG_POOL],
    };
  }
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

export interface ServiceConfig {
  name: string;
  port: number;
  /** The service's own Nest module. */
  module: any;
  pool?: Pool | undefined;
  /** Start an outbox relay for services that emit events. */
  amqpUrl?: string | undefined;
  host?: string;
  logger?: boolean;
}

export interface RunningService {
  app: NestFastifyApplication;
  url: string;
  stop: () => Promise<void>;
}

export async function createService(cfg: ServiceConfig): Promise<RunningService> {
  health.serviceName = cfg.name;
  health.startedAt = new Date();
  health.accepting = true;

  const app = await NestFactory.create<NestFastifyApplication>(
    cfg.module,
    new FastifyAdapter({ bodyLimit: 10 * 1024 * 1024 }),
    { logger: cfg.logger ? ['error', 'warn', 'log'] : false },
  );

  app.useGlobalFilters(new ProblemDetailsFilter());

  // Fastify rejects a request that declares `content-type: application/json`
  // but carries an empty body (FST_ERR_CTP_EMPTY_JSON_BODY → 400, and not in
  // our RFC-7807 shape). Dart's http package sets that header on every
  // request, including bodyless DELETEs and POSTs, so "remove address" would
  // fail for all three apps. Drop the header when there is demonstrably no
  // body, which routes the request past the parser entirely.
  app.getHttpAdapter().getInstance()
    .addHook('onRequest', (req: any, _reply: any, done: () => void) => {
      const len = req.headers['content-length'];
      if ((len === undefined || len === '0') && req.headers['transfer-encoding'] === undefined) {
        delete req.headers['content-type'];
      }
      done();
    });

  // Fastify hook rather than Nest middleware: this must run for EVERY
  // request, including ones that never reach a controller (404s), because
  // those are exactly the responses you need a correlation id on.
  const correlation = new CorrelationMiddleware();
  app.getHttpAdapter().getInstance()
    .addHook('onRequest', (req: any, reply: any, done: () => void) => {
      correlation.use(req, reply, done);
    });

  /* ---- outbox relay ---- */
  let publisher: AmqpPublisher | undefined;
  let runner: RelayRunner | undefined;
  if (cfg.pool && cfg.amqpUrl) {
    publisher = new AmqpPublisher({ url: cfg.amqpUrl });
    await publisher.connect();
    runner = new RelayRunner(
      new OutboxRelay(cfg.pool, publisher),
      { idleMs: 1_000, busyMs: 50 },
      (e) => console.error(`[${cfg.name}] relay error:`, e.message),
    );
    runner.start();
  }

  const host = cfg.host ?? '0.0.0.0';
  await app.listen(cfg.port, host);

  const stop = async () => {
    // Stop accepting BEFORE tearing anything down, so in-flight requests
    // finish and the load balancer removes us cleanly.
    health.accepting = false;
    await new Promise((r) => setTimeout(r, 100));
    runner?.stop();
    await publisher?.close().catch(() => {});
    await app.close();
  };

  return { app, url: `http://${host}:${cfg.port}`, stop };
}

/**
 * SIGTERM/SIGINT handling. Kubernetes sends SIGTERM and waits; without this
 * the process dies instantly and in-flight orders return connection errors.
 */
export function installShutdownHandlers(svc: RunningService, log = console): void {
  let shuttingDown = false;
  const handler = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.log?.(`received ${signal}, draining…`);
    try {
      await svc.stop();
      process.exit(0);
    } catch (e) {
      log.error?.('shutdown failed', e);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void handler('SIGTERM'));
  process.on('SIGINT', () => void handler('SIGINT'));
}

/** Fail fast at boot rather than at the first request. */
export function requireEnv(keys: string[], env = process.env): Record<string, string> {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`missing required environment variables: ${missing.join(', ')}`);
  }
  return Object.fromEntries(keys.map((k) => [k, env[k]!]));
}

export function portFor(serviceName: string, env = process.env): number {
  const explicit = env.PORT ?? env[`${serviceName.toUpperCase().replace(/-/g, '_')}_PORT`];
  if (explicit) return Number(explicit);
  return DEFAULT_PORTS[serviceName] ?? 3000;
}

/** One place that knows which service listens where. */
export const DEFAULT_PORTS: Record<string, number> = {
  gateway: 3000,
  'svc-identity': 3001,
  'svc-catalogue': 3002,
  'svc-order': 3003,
  'svc-pricing': 3004,
  'svc-dispatch': 3005,
  'svc-tracking': 3006,
  'svc-payment': 3007,
  'svc-messaging': 3008,
  'svc-media': 3009,
  'svc-admin': 3010,
  'bff-customer': 3101,
  'bff-vendor': 3102,
  'bff-rider': 3103,
  'bff-admin': 3104,
};
