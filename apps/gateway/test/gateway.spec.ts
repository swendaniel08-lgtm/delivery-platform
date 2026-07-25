/** gateway.spec — authentication, routing, rate limiting, header forwarding. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  Gateway, InMemoryRateLimitStore, matchRoute, tierFor, corsHeaders,
  RATE_TIERS, SECURITY_HEADERS, ROUTES, type IncomingRequest,
} from '../src/gateway.ts';
import {
  TokenService, InMemorySessionStore, DEFAULT_TOKEN_CONFIG, type Principal,
} from '../../svc-identity/src/token/token-service.ts';
import { UnauthorizedError, RateLimitError, NotFoundError } from '../../../libs/platform/src/errors.ts';

function harness() {
  let now = 1_700_000_000_000;
  const tokens = new TokenService(
    { accessSecret: 'acc', refreshSecret: 'ref', ...DEFAULT_TOKEN_CONFIG },
    new InMemorySessionStore(), () => now,
  );
  const limiter = new InMemoryRateLimitStore(() => now);
  const gw = new Gateway(tokens, limiter, { trustProxy: true });
  return { gw, tokens, advance: (s: number) => (now += s * 1000) };
}

const req = (over: Partial<IncomingRequest> = {}): IncomingRequest => ({
  method: 'GET', path: '/api/customer/orders', headers: {}, ip: '10.0.0.1', ...over,
});

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe('routing', () => {
  test('matches by prefix', () => {
    assert.equal(matchRoute('/api/customer/orders').prefix, '/api/customer');
    assert.equal(matchRoute('/api/rider/assignments/1/accept').prefix, '/api/rider');
  });

  test('an exact prefix match works', () => {
    assert.equal(matchRoute('/api/admin').prefix, '/api/admin');
  });

  test('a prefix must not match a longer word', () => {
    assert.throws(() => matchRoute('/api/customerX/orders'), NotFoundError);
  });

  test('unknown paths 404', () => {
    assert.throws(() => matchRoute('/nope'), NotFoundError);
  });

  test('the upstream path is rewritten to what the service actually serves', async () => {
    const { gw, tokens } = harness();
    const pair = await tokens.issue({ userId: 'u1', role: 'customer' });

    // A BFF mounts '/api/customer' itself, so the prefix is PRESERVED.
    const bff = await gw.handle(req({
      path: '/api/customer/orders/123', headers: bearer(pair.accessToken),
    }));
    assert.match(bff.target, /\/api\/customer\/orders\/123$/);
  });

  test('identity routes are rewritten from /api/auth to /auth', async () => {
    const { gw } = harness();
    // The public path and the service's own path are different: clients call
    // '/api/auth/otp/request' but identity-svc serves '/auth/otp/request'.
    // Stripping the whole prefix asks for '/otp/request', which 404s — this
    // was a real bug found by running the stack end to end.
    const d = await gw.handle(req({ path: '/api/auth/otp/request' }));
    assert.match(d.target, /\/auth\/otp\/request$/);
    assert.equal(d.target.includes('/api/auth'), false);
  });

  test('webhooks reach the payment service signature route', async () => {
    const { gw } = harness();
    const d = await gw.handle(req({ path: '/api/webhooks/paystack' }));
    assert.match(d.target, /\/payments\/webhooks\/paystack$/);
  });
});

describe('authentication', () => {
  test('a protected route without a token is rejected', async () => {
    const { gw } = harness();
    await assert.rejects(() => gw.handle(req()), UnauthorizedError);
  });

  test('a valid token passes', async () => {
    const { gw, tokens } = harness();
    const pair = await tokens.issue({ userId: 'u1', role: 'customer' });
    const d = await gw.handle(req({ headers: bearer(pair.accessToken) }));
    assert.equal(d.principal?.sub, 'u1');
  });

  test('an expired token is rejected', async () => {
    const { gw, tokens, advance } = harness();
    const pair = await tokens.issue({ userId: 'u1', role: 'customer' });
    advance(16 * 60);
    await assert.rejects(() => gw.handle(req({ headers: bearer(pair.accessToken) })), UnauthorizedError);
  });

  test('a forged token is rejected', async () => {
    const { gw } = harness();
    await assert.rejects(
      () => gw.handle(req({ headers: bearer('a.b.c') })), UnauthorizedError);
  });

  test('public routes work anonymously', async () => {
    const { gw } = harness();
    const d = await gw.handle(req({ path: '/api/auth/otp/request' }));
    assert.equal(d.principal, null);
  });

  test('an EXPIRED token on a public route does not block a fresh login', async () => {
    const { gw, tokens, advance } = harness();
    const pair = await tokens.issue({ userId: 'u1', role: 'customer' });
    advance(16 * 60);
    const d = await gw.handle(req({ path: '/api/auth/otp/request', headers: bearer(pair.accessToken) }));
    assert.equal(d.principal, null, 'should fall through to anonymous, not 401');
  });

  test('Paystack webhooks are reachable without a token', async () => {
    const { gw } = harness();
    const d = await gw.handle(req({ method: 'POST', path: '/api/webhooks/paystack' }));
    assert.equal(d.route.public, true);
  });
});

describe('role gating at the edge', () => {
  test('a customer cannot reach rider endpoints', async () => {
    const { gw, tokens } = harness();
    const pair = await tokens.issue({ userId: 'u1', role: 'customer' });
    await assert.rejects(
      () => gw.handle(req({ path: '/api/rider/assignments', headers: bearer(pair.accessToken) })),
      UnauthorizedError,
    );
  });

  test('a rider cannot reach admin endpoints', async () => {
    const { gw, tokens } = harness();
    const pair = await tokens.issue({ userId: 'r1', role: 'rider' });
    await assert.rejects(
      () => gw.handle(req({ path: '/api/admin/payments', headers: bearer(pair.accessToken) })),
      UnauthorizedError,
    );
  });

  test('vendor_staff and vendor_owner both reach vendor endpoints', async () => {
    const { gw, tokens } = harness();
    for (const role of ['vendor_owner', 'vendor_staff'] as const) {
      const pair = await tokens.issue({ userId: `v-${role}`, role, vendorId: 'ven-1' });
      const d = await gw.handle(req({ path: '/api/vendor/orders', headers: bearer(pair.accessToken) }));
      assert.equal(d.principal?.role, role);
    }
  });
});

describe('rate limiting', () => {
  test('anonymous traffic is throttled hardest', async () => {
    const { gw } = harness();
    for (let i = 0; i < RATE_TIERS.anonymous.max; i++) {
      await gw.handle(req({ path: '/api/auth/otp/request' }));
    }
    await assert.rejects(
      () => gw.handle(req({ path: '/api/auth/otp/request' })), RateLimitError);
  });

  test('limits are per USER, not per IP, for authenticated traffic', async () => {
    const { gw, tokens } = harness();
    const a = await tokens.issue({ userId: 'user-a', role: 'customer' });
    const b = await tokens.issue({ userId: 'user-b', role: 'customer' });

    // exhaust user A from a shared IP (a busy café / carrier NAT)
    for (let i = 0; i < RATE_TIERS.customer.max; i++) {
      await gw.handle(req({ headers: bearer(a.accessToken) }));
    }
    await assert.rejects(() => gw.handle(req({ headers: bearer(a.accessToken) })), RateLimitError);

    // user B on the SAME ip must be unaffected
    const d = await gw.handle(req({ headers: bearer(b.accessToken) }));
    assert.equal(d.principal?.sub, 'user-b');
  });

  test('riders get the most headroom — they ping constantly', () => {
    assert.ok(RATE_TIERS.rider.max > RATE_TIERS.customer.max);
    assert.ok(RATE_TIERS.customer.max > RATE_TIERS.anonymous.max);
  });

  test('the window resets', async () => {
    const { gw, advance } = harness();
    for (let i = 0; i < RATE_TIERS.anonymous.max; i++) {
      await gw.handle(req({ path: '/api/auth/otp/request' }));
    }
    await assert.rejects(() => gw.handle(req({ path: '/api/auth/otp/request' })), RateLimitError);
    advance(61);
    await gw.handle(req({ path: '/api/auth/otp/request' }));
  });

  test('RateLimitError carries Retry-After', async () => {
    const { gw } = harness();
    for (let i = 0; i < RATE_TIERS.anonymous.max; i++) {
      await gw.handle(req({ path: '/api/auth/otp/request' }));
    }
    await assert.rejects(() => gw.handle(req({ path: '/api/auth/otp/request' })), (e: unknown) => {
      assert.ok(e instanceof RateLimitError);
      assert.ok(e.retryAfterSeconds > 0 && e.retryAfterSeconds <= 60);
      return true;
    });
  });

  test('tier selection maps roles correctly', () => {
    assert.equal(tierFor(null), 'anonymous');
    assert.equal(tierFor({ role: 'vendor_staff' } as any), 'vendor');
    assert.equal(tierFor({ role: 'admin' } as any), 'admin');
  });
});

describe('identity forwarding', () => {
  test('verified identity is passed downstream', async () => {
    const { gw, tokens } = harness();
    const pair = await tokens.issue({
      userId: 'u1', role: 'admin', scope: 'finance', zones: ['accra-osu', 'tema'],
    });
    const d = await gw.handle(req({ path: '/api/admin/payments', headers: bearer(pair.accessToken) }));
    assert.equal(d.forwardHeaders['x-user-id'], 'u1');
    assert.equal(d.forwardHeaders['x-user-role'], 'admin');
    assert.equal(d.forwardHeaders['x-user-scope'], 'finance');
    assert.equal(d.forwardHeaders['x-user-zones'], 'accra-osu,tema');
    assert.equal(d.forwardHeaders['x-gateway-verified'], 'true');
  });

  test('anonymous requests forward NO identity headers', async () => {
    const { gw } = harness();
    const d = await gw.handle(req({ path: '/api/auth/otp/request' }));
    assert.equal(d.forwardHeaders['x-user-id'], undefined);
    assert.equal(d.forwardHeaders['x-user-role'], undefined);
  });

  test('a client cannot spoof identity headers — the gateway sets them', async () => {
    const { gw, tokens } = harness();
    const pair = await tokens.issue({ userId: 'real-user', role: 'customer' });
    const d = await gw.handle(req({
      headers: { ...bearer(pair.accessToken), 'x-user-id': 'attacker', 'x-user-role': 'admin' },
    }));
    assert.equal(d.forwardHeaders['x-user-id'], 'real-user');
    assert.equal(d.forwardHeaders['x-user-role'], 'customer');
  });

  test('correlation ids are generated when absent and preserved when present', async () => {
    const { gw } = harness();
    const generated = await gw.handle(req({ path: '/api/auth/x' }));
    assert.match(generated.correlationId, /^[0-9a-f-]{36}$/);

    const passed = await gw.handle(req({
      path: '/api/auth/x', headers: { 'x-correlation-id': 'trace-123' },
    }));
    assert.equal(passed.correlationId, 'trace-123');
  });

  test('the real client IP is taken from X-Forwarded-For behind a proxy', async () => {
    const { gw } = harness();
    const d = await gw.handle(req({
      path: '/api/auth/x', ip: '172.16.0.1',
      headers: { 'x-forwarded-for': '154.160.1.5, 172.16.0.1' },
    }));
    assert.equal(d.forwardHeaders['x-client-ip'], '154.160.1.5');
  });
});

describe('security headers and CORS', () => {
  test('clickjacking and sniffing protections are set', () => {
    assert.equal(SECURITY_HEADERS['x-frame-options'], 'DENY');
    assert.equal(SECURITY_HEADERS['x-content-type-options'], 'nosniff');
    assert.match(SECURITY_HEADERS['strict-transport-security']!, /max-age=\d+/);
  });

  test('CORS is an allow-list, not a wildcard', () => {
    const opts = { allowedOrigins: ['https://admin.besonc.app'] };
    assert.equal(corsHeaders('https://admin.besonc.app', opts)['access-control-allow-origin'],
      'https://admin.besonc.app');
    assert.deepEqual(corsHeaders('https://evil.example', opts), {});
    assert.deepEqual(corsHeaders(undefined, opts), {}, 'native apps send no Origin');
  });
});

describe('route table', () => {
  test('every non-public route restricts roles', () => {
    for (const r of ROUTES) {
      if (!r.public) {
        assert.ok(r.roles?.length, `${r.prefix} has no role restriction`);
      }
    }
  });

  test('only auth and webhooks are public', () => {
    const publics = ROUTES.filter((r) => r.public).map((r) => r.prefix);
    assert.deepEqual(publics.sort(), ['/api/auth', '/api/webhooks']);
  });
});
