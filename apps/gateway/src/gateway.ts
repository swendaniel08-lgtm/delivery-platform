/**
 * API Gateway. MASTER_PLAN §3.1.
 *
 * The single front door: JWT verification, rate limiting, routing to BFFs,
 * correlation-ID injection, CORS and security headers.
 *
 * Design rule: the gateway authenticates but does NOT authorise. It proves
 * *who* you are and passes verified identity downstream; each service decides
 * *what* you may do using its own domain knowledge. A gateway that tries to
 * enforce business permissions ends up duplicating every service's rules and
 * drifting out of sync with them.
 */

import { randomUUID } from 'node:crypto';
import { TokenService, type AccessClaims } from '../../svc-identity/src/token/token-service.ts';
import { RateLimitError, UnauthorizedError, NotFoundError } from '../../../libs/platform/src/errors.ts';

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

export interface RouteRule {
  /** Path prefix, e.g. '/api/customer'. */
  prefix: string;
  /** Upstream base URL. */
  target: string;
  /** Anonymous access allowed (login, OTP, webhooks). */
  public?: boolean;
  /** Roles permitted at the edge. Fine-grained checks live downstream. */
  roles?: AccessClaims['role'][];
}

export const ROUTES: RouteRule[] = [
  { prefix: '/api/auth',     target: 'http://svc-identity:3001', public: true },
  { prefix: '/api/webhooks', target: 'http://svc-payment:3007',  public: true },
  { prefix: '/api/customer', target: 'http://bff-customer:3101', roles: ['customer'] },
  { prefix: '/api/vendor',   target: 'http://bff-vendor:3102',   roles: ['vendor_owner', 'vendor_staff'] },
  { prefix: '/api/rider',    target: 'http://bff-rider:3103',    roles: ['rider'] },
  { prefix: '/api/admin',    target: 'http://bff-admin:3104',    roles: ['admin'] },
];

export function matchRoute(path: string, routes: RouteRule[] = ROUTES): RouteRule {
  const hit = routes.find((r) => path === r.prefix || path.startsWith(`${r.prefix}/`));
  if (!hit) throw new NotFoundError('Route');
  return hit;
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

export interface RateLimitStore {
  /** Increment and return the new count; sets TTL on first write. */
  hit(key: string, windowSeconds: number): Promise<{ count: number; ttlSeconds: number }>;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private data = new Map<string, { count: number; expiresAt: number }>();
  constructor(private nowMs: () => number = Date.now) {}
  async hit(key: string, windowSeconds: number) {
    const now = this.nowMs();
    const cur = this.data.get(key);
    if (!cur || cur.expiresAt <= now) {
      this.data.set(key, { count: 1, expiresAt: now + windowSeconds * 1000 });
      return { count: 1, ttlSeconds: windowSeconds };
    }
    cur.count++;
    return { count: cur.count, ttlSeconds: Math.ceil((cur.expiresAt - now) / 1000) };
  }
}

export interface RateLimitTier {
  windowSeconds: number;
  max: number;
}

/**
 * Tiers by principal type. Anonymous traffic is throttled hardest because
 * that is where credential stuffing and SMS pumping arrive; riders get the
 * most headroom because their apps ping location constantly.
 */
export const RATE_TIERS: Record<'anonymous' | 'customer' | 'vendor' | 'rider' | 'admin', RateLimitTier> = {
  anonymous: { windowSeconds: 60, max: 30 },
  customer:  { windowSeconds: 60, max: 120 },
  vendor:    { windowSeconds: 60, max: 240 },
  rider:     { windowSeconds: 60, max: 600 },
  admin:     { windowSeconds: 60, max: 300 },
};

export function tierFor(claims: AccessClaims | null): keyof typeof RATE_TIERS {
  if (!claims) return 'anonymous';
  switch (claims.role) {
    case 'customer': return 'customer';
    case 'vendor_owner': case 'vendor_staff': return 'vendor';
    case 'rider': return 'rider';
    case 'admin': return 'admin';
    default: return 'anonymous';
  }
}

/* ------------------------------------------------------------------ */
/* Request handling                                                    */
/* ------------------------------------------------------------------ */

export interface IncomingRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  ip: string;
}

export interface GatewayDecision {
  allow: true;
  route: RouteRule;
  target: string;
  correlationId: string;
  /** Verified identity forwarded downstream — services trust these. */
  forwardHeaders: Record<string, string>;
  principal: AccessClaims | null;
}

export interface GatewayOptions {
  /** Trust X-Forwarded-For (only behind a real load balancer). */
  trustProxy?: boolean;
  routes?: RouteRule[];
}

export class Gateway {
  private readonly routes: RouteRule[];

  constructor(
    private readonly tokens: TokenService,
    private readonly limiter: RateLimitStore,
    private readonly opts: GatewayOptions = {},
  ) {
    this.routes = opts.routes ?? ROUTES;
  }

  private clientIp(req: IncomingRequest): string {
    if (this.opts.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      // leftmost entry is the original client
      if (fwd) return fwd.split(',')[0]!.trim();
    }
    return req.ip;
  }

  async handle(req: IncomingRequest): Promise<GatewayDecision> {
    const route = matchRoute(req.path, this.routes);
    const correlationId = req.headers['x-correlation-id'] ?? randomUUID();

    /* ---- authenticate ---- */
    let principal: AccessClaims | null = null;
    const auth = req.headers['authorization'];
    if (auth?.startsWith('Bearer ')) {
      // An invalid token on a PUBLIC route is ignored rather than rejected,
      // so an expired session never blocks a fresh login.
      try {
        principal = this.tokens.verifyAccess(auth.slice(7));
      } catch (err) {
        if (!route.public) throw err;
      }
    }

    if (!route.public && !principal) {
      throw new UnauthorizedError('Authentication required');
    }

    /* ---- coarse role gate at the edge ---- */
    if (route.roles && principal && !route.roles.includes(principal.role)) {
      throw new UnauthorizedError('This endpoint is not available for your account type');
    }

    /* ---- rate limit ---- */
    const tier = tierFor(principal);
    const cfg = RATE_TIERS[tier];
    // Authenticated traffic is limited per user; anonymous per IP.
    const key = principal ? `rl:user:${principal.sub}` : `rl:ip:${this.clientIp(req)}`;
    const { count, ttlSeconds } = await this.limiter.hit(key, cfg.windowSeconds);
    if (count > cfg.max) {
      throw new RateLimitError(ttlSeconds, 'Too many requests — please slow down');
    }

    /* ---- forward verified identity ---- */
    const forwardHeaders: Record<string, string> = {
      'x-correlation-id': correlationId,
      'x-gateway-verified': 'true',
      'x-client-ip': this.clientIp(req),
    };
    if (principal) {
      forwardHeaders['x-user-id'] = principal.sub;
      forwardHeaders['x-user-role'] = principal.role;
      if (principal.scope) forwardHeaders['x-user-scope'] = principal.scope;
      if (principal.vendorId) forwardHeaders['x-vendor-id'] = principal.vendorId;
      if (principal.zones?.length) forwardHeaders['x-user-zones'] = principal.zones.join(',');
    }

    return {
      allow: true,
      route,
      target: route.target + req.path.slice(route.prefix.length),
      correlationId,
      forwardHeaders,
      principal,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Security headers                                                    */
/* ------------------------------------------------------------------ */

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
};

export interface CorsOptions {
  allowedOrigins: string[];
}

/**
 * Strict allow-list CORS. The mobile apps are native and send no Origin;
 * only the admin dashboard and vendor web need this.
 */
export function corsHeaders(origin: string | undefined, opts: CorsOptions): Record<string, string> {
  if (!origin || !opts.allowedOrigins.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'authorization,content-type,idempotency-key,x-correlation-id',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}
