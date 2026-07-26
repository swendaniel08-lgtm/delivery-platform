/**
 * gateway entrypoint — the single public door into Besonc.
 *
 * The `Gateway` class decides; this file does. It is a plain Fastify reverse
 * proxy rather than Nest, because a gateway that parses every request body
 * into DTOs it will only re-serialise is wasted work on the hottest path in
 * the system — and it would break Paystack's raw-body signatures.
 *
 * Run: `npx tsx apps/gateway/src/main.ts`
 */

import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';

import {
  Gateway, InMemoryRateLimitStore, SECURITY_HEADERS, corsHeaders, RATE_TIERS,
  type RouteRule,
} from './gateway.ts';
import { TokenService, InMemorySessionStore } from '../../svc-identity/src/token/token-service.ts';
import {
  jwtFrom, optional, boolFrom, numberFrom, describeConfig, ConfigError, isProduction,
} from '../../../libs/platform/src/config/env.ts';
import { AppError } from '../../../libs/platform/src/errors.ts';

const NAME = 'gateway';

/**
 * Upstreams come from the environment so the same image runs under Docker
 * Compose (`http://svc-identity:3001`) and on a laptop (`http://127.0.0.1:3001`).
 */
function routesFromEnv(): RouteRule[] {
  const u = (key: string, fallback: string) => optional(key, fallback);
  return [
    { prefix: '/api/auth', target: u('SVC_IDENTITY_URL', 'http://127.0.0.1:3001'), public: true, rewriteTo: '/auth' },
    // Every signed-in principal manages their OWN profile; identity-svc
    // scopes each request to the token's subject.
    { prefix: '/api/users', target: u('SVC_IDENTITY_URL', 'http://127.0.0.1:3001'), roles: ['customer', 'vendor_owner', 'vendor_staff', 'rider', 'admin'], rewriteTo: '/users' },
    // Webhooks are public by necessity — the PSP has no bearer token. They
    // are authenticated by SIGNATURE inside payment-svc instead.
    { prefix: '/api/webhooks', target: u('SVC_PAYMENT_URL', 'http://127.0.0.1:3007'), public: true, rewriteTo: '/payments/webhooks' },
    { prefix: '/api/customer', target: u('BFF_CUSTOMER_URL', 'http://127.0.0.1:3101'), roles: ['customer'], rewriteTo: '/api/customer' },
    { prefix: '/api/vendor', target: u('BFF_VENDOR_URL', 'http://127.0.0.1:3102'), roles: ['vendor_owner', 'vendor_staff'], rewriteTo: '/api/vendor' },
    { prefix: '/api/rider', target: u('BFF_RIDER_URL', 'http://127.0.0.1:3103'), roles: ['rider'], rewriteTo: '/api/rider' },
    { prefix: '/api/admin', target: u('BFF_ADMIN_URL', 'http://127.0.0.1:3104'), roles: ['admin'], rewriteTo: '/api/admin' },
  ];
}

async function main() {
  for (const line of describeConfig(NAME)) console.log(line);

  const jwt = jwtFrom();
  const routes = routesFromEnv();
  const port = numberFrom('PORT', 3000);

  // trustProxy must be OFF unless a load balancer we control sets
  // X-Forwarded-For. Otherwise any client can spoof its IP and walk
  // straight through the anonymous rate limit.
  const trustProxy = boolFrom('TRUST_PROXY', false);
  if (isProduction() && !trustProxy) {
    console.warn(`[${NAME}] TRUST_PROXY is false — rate limits will bucket every `
      + 'request behind the load balancer as one client. Set it to true once '
      + 'the LB is the only thing that can reach this port.');
  }

  const tokens = new TokenService(
    {
      accessSecret: jwt.accessSecret,
      refreshSecret: jwt.refreshSecret,
      accessTtlSeconds: jwt.accessTtlSeconds,
      refreshTtlSeconds: jwt.refreshTtlSeconds,
    },
    // The gateway only VERIFIES access tokens; it never mints or rotates,
    // so it needs no session storage.
    new InMemorySessionStore(),
  );

  // Integration suites drive dozens of sign-ins from ONE IP and trip the
  // 30/minute anonymous ceiling. That ceiling is the brute-force defence
  // and must not be weakened in production, so it is scaled by config and
  // the multiplier is ignored when NODE_ENV=production.
  const limitScale = isProduction() ? 1 : numberFrom('RATE_LIMIT_SCALE', 1);
  if (limitScale !== 1) {
    console.warn(`[${NAME}] rate limits scaled x${limitScale} — never do this `
      + 'outside a test environment');
    for (const tier of Object.values(RATE_TIERS)) {
      tier.max = Math.round(tier.max * limitScale);
    }
  }

  const gateway = new Gateway(tokens, new InMemoryRateLimitStore(), { trustProxy, routes });

  const app = Fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024,
    // Do not parse anything: we forward bytes untouched. This is what keeps
    // Paystack's raw-body signature intact through the proxy.
    disableRequestLogging: true,
  });

  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  const allowedOrigins = optional('CORS_ORIGINS', '').split(',').filter(Boolean);

  app.route({
    method: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    url: '/*',
    handler: async (req, reply) => {
      const origin = req.headers.origin as string | undefined;
      const cors = corsHeaders(origin, { allowedOrigins });
      for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...cors })) {
        reply.header(k, v);
      }
      if (req.method === 'OPTIONS') return reply.code(204).send();

      try {
        const decision = await gateway.handle({
          method: req.method,
          path: req.url.split('?')[0]!,
          headers: req.headers as Record<string, string | undefined>,
          ip: req.ip,
        });

        const query = req.url.includes('?') ? `?${req.url.split('?')[1]}` : '';
        const upstream = `${decision.target}${query}`;

        // Strip hop-by-hop headers and anything a client could use to
        // impersonate a verified identity — `x-user-id` is trusted
        // downstream, so it must only ever come from us.
        const outgoing: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          const key = k.toLowerCase();
          if (['host', 'connection', 'content-length', 'transfer-encoding'].includes(key)) continue;
          if (key.startsWith('x-user-') || key === 'x-gateway-verified'
              || key === 'x-vendor-id' || key === 'x-client-ip') continue;
          if (typeof v === 'string') outgoing[key] = v;
        }
        Object.assign(outgoing, decision.forwardHeaders);

        const body = req.method === 'GET' || req.method === 'DELETE'
          ? undefined
          : (req.body as Buffer | undefined);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), numberFrom('UPSTREAM_TIMEOUT_MS', 15_000));

        try {
          const res = await fetch(upstream, {
            method: req.method,
            headers: outgoing,
            ...(body && body.length ? { body } : {}),
            signal: controller.signal,
          });

          reply.code(res.status);
          res.headers.forEach((value, key) => {
            if (['content-encoding', 'transfer-encoding', 'connection'].includes(key)) return;
            reply.header(key, value);
          });
          reply.header('x-correlation-id', decision.correlationId);
          return reply.send(Buffer.from(await res.arrayBuffer()));
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        return sendProblem(reply, err, req.url);
      }
    },
  });

  app.get('/health', async () => ({ status: 'ok', service: NAME }));

  await app.listen({ port, host: '0.0.0.0' });
  console.log(`[${NAME}] listening on http://0.0.0.0:${port}`);
  for (const r of routes) {
    console.log(`[${NAME}]   ${r.prefix.padEnd(14)} -> ${r.target}`
      + `${r.public ? ' (public)' : ''}`);
  }

  const shutdown = async (signal: string) => {
    console.log(`[${NAME}] received ${signal}, draining…`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/** Errors leave the gateway in the same RFC-7807 shape as every service. */
function sendProblem(reply: any, err: unknown, instance: string) {
  const correlationId = randomUUID();
  if (err instanceof AppError) {
    const problem = err.toProblem(correlationId, instance);
    if (err.status === 429) {
      reply.header('retry-after', String((err as any).retryAfterSeconds ?? 60));
    }
    return reply.code(err.status).type('application/problem+json').send(problem);
  }
  const e = err as Error;
  const upstreamDown = e?.name === 'AbortError' || /fetch failed/i.test(e?.message ?? '');
  return reply
    .code(upstreamDown ? 503 : 500)
    .type('application/problem+json')
    .send({
      type: 'https://errors.besonc.app/upstream-failure',
      title: upstreamDown ? 'Service Unavailable' : 'Internal Server Error',
      status: upstreamDown ? 503 : 500,
      instance,
      correlationId,
    });
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(`\n[${NAME}] CONFIGURATION ERROR\n  ${err.message}\n`);
    process.exit(78);
  }
  console.error(`[${NAME}] failed to start:`, err);
  process.exit(1);
});
