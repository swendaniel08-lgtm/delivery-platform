/**
 * JWT issuance with refresh-token ROTATION and reuse detection.
 *
 * Carried from Sprint 2 (needed a runtime). MASTER_PLAN §3.1.
 *
 * Threat model: a rider's phone is stolen or a token is exfiltrated from a
 * compromised device. With plain long-lived refresh tokens the attacker keeps
 * access forever. With rotation + reuse detection, the moment either party
 * replays a spent token the entire family is revoked and both are logged out.
 * For a platform moving real money to riders' wallets this is not optional.
 */

import { createHmac, randomBytes, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import { UnauthorizedError } from '../../../../libs/platform/src/errors.ts';

export type Role = 'customer' | 'vendor_owner' | 'vendor_staff' | 'rider' | 'admin';

export interface AccessClaims {
  sub: string;
  role: Role;
  /** Admin sub-role, e.g. finance / dispatcher. Drives CASL abilities. */
  scope?: string;
  vendorId?: string;
  zones?: string[];
  iat: number;
  exp: number;
  jti: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  sessionId: string;
}

/** Persistence port — Postgres `sessions` table in production. */
export interface SessionStore {
  create(row: {
    id: string;
    userId: string;
    refreshTokenHash: string;
    deviceId?: string;
    expiresAt: number;
  }): Promise<void>;
  findByHash(hash: string): Promise<{
    id: string;
    userId: string;
    expiresAt: number;
    revokedAt: number | null;
    replacedBy: string | null;
  } | null>;
  markReplaced(id: string, replacedBy: string): Promise<void>;
  /** Revoke every live session for a user — the reuse-detection hammer. */
  revokeAllForUser(userId: string, reason: string): Promise<number>;
}

export class InMemorySessionStore implements SessionStore {
  rows = new Map<string, {
    id: string; userId: string; refreshTokenHash: string;
    expiresAt: number; revokedAt: number | null; replacedBy: string | null;
  }>();
  revocations: Array<{ userId: string; reason: string; count: number }> = [];

  async create(row: { id: string; userId: string; refreshTokenHash: string; expiresAt: number }) {
    this.rows.set(row.id, { ...row, revokedAt: null, replacedBy: null });
  }
  async findByHash(hash: string) {
    for (const r of this.rows.values()) if (r.refreshTokenHash === hash) return { ...r };
    return null;
  }
  async markReplaced(id: string, replacedBy: string) {
    const r = this.rows.get(id);
    if (r) { r.replacedBy = replacedBy; r.revokedAt = Date.now(); }
  }
  async revokeAllForUser(userId: string, reason: string) {
    let n = 0;
    for (const r of this.rows.values()) {
      if (r.userId === userId && r.revokedAt === null) { r.revokedAt = Date.now(); n++; }
    }
    this.revocations.push({ userId, reason, count: n });
    return n;
  }
}

export interface TokenConfig {
  accessSecret: string;
  refreshSecret: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

export const DEFAULT_TOKEN_CONFIG: Omit<TokenConfig, 'accessSecret' | 'refreshSecret'> = {
  accessTtlSeconds: 15 * 60,          // 15 minutes
  refreshTtlSeconds: 30 * 24 * 3600,  // 30 days
};

/* --------------------------- JWT (HS256) --------------------------- */

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64urlDecode = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function sign(payload: object, secret: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = b64url(createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

function verify<T>(token: string, secret: string, nowSeconds: number): T {
  const parts = token.split('.');
  if (parts.length !== 3) throw new UnauthorizedError('Malformed token');
  const [header, body, sig] = parts as [string, string, string];

  // Reject alg confusion outright — never trust the header's alg.
  let head: { alg?: string };
  try { head = JSON.parse(b64urlDecode(header).toString()); }
  catch { throw new UnauthorizedError('Malformed token header'); }
  if (head.alg !== 'HS256') throw new UnauthorizedError('Unsupported token algorithm');

  const expected = b64url(createHmac('sha256', secret).update(`${header}.${body}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !nodeTimingSafeEqual(a, b)) {
    throw new UnauthorizedError('Invalid token signature');
  }

  let claims: T & { exp?: number };
  try { claims = JSON.parse(b64urlDecode(body).toString()); }
  catch { throw new UnauthorizedError('Malformed token body'); }

  if (typeof claims.exp === 'number' && claims.exp <= nowSeconds) {
    throw new UnauthorizedError('Token expired');
  }
  return claims;
}

/* --------------------------- Service --------------------------- */

export interface Principal {
  userId: string;
  role: Role;
  scope?: string;
  vendorId?: string;
  zones?: string[];
}

export class TokenService {
  constructor(
    private readonly cfg: TokenConfig,
    private readonly sessions: SessionStore,
    private readonly nowMs: () => number = Date.now,
    private readonly randomId: () => string = () => randomBytes(16).toString('hex'),
  ) {}

  private hashRefresh(token: string): string {
    return createHmac('sha256', this.cfg.refreshSecret).update(token).digest('hex');
  }

  async issue(p: Principal, deviceId?: string): Promise<TokenPair> {
    const nowS = Math.floor(this.nowMs() / 1000);
    const sessionId = this.randomId();

    const claims: AccessClaims = {
      sub: p.userId,
      role: p.role,
      ...(p.scope ? { scope: p.scope } : {}),
      ...(p.vendorId ? { vendorId: p.vendorId } : {}),
      ...(p.zones ? { zones: p.zones } : {}),
      iat: nowS,
      exp: nowS + this.cfg.accessTtlSeconds,
      jti: this.randomId(),
    };

    const accessToken = sign(claims, this.cfg.accessSecret);
    const refreshToken = `${sessionId}.${randomBytes(32).toString('hex')}`;
    const refreshExpiresAt = this.nowMs() + this.cfg.refreshTtlSeconds * 1000;

    await this.sessions.create({
      id: sessionId,
      userId: p.userId,
      refreshTokenHash: this.hashRefresh(refreshToken),
      ...(deviceId ? { deviceId } : {}),
      expiresAt: refreshExpiresAt,
    });

    return {
      accessToken,
      refreshToken,
      accessExpiresAt: claims.exp * 1000,
      refreshExpiresAt,
      sessionId,
    };
  }

  verifyAccess(token: string): AccessClaims {
    return verify<AccessClaims>(token, this.cfg.accessSecret, Math.floor(this.nowMs() / 1000));
  }

  /**
   * Rotate. The presented refresh token is spent; a brand-new one is issued.
   *
   * If a token that has ALREADY been rotated is presented again, that means
   * two parties hold it — legitimate client and attacker. We cannot tell which
   * is which, so we revoke the entire family and force a fresh login.
   */
  async refresh(refreshToken: string, principal: Principal, deviceId?: string): Promise<TokenPair> {
    const hash = this.hashRefresh(refreshToken);
    const row = await this.sessions.findByHash(hash);

    if (!row) throw new UnauthorizedError('Invalid refresh token');

    if (row.replacedBy !== null) {
      // REUSE DETECTED
      await this.sessions.revokeAllForUser(row.userId, 'refresh_token_reuse');
      throw new UnauthorizedError('Session compromised — please sign in again');
    }
    if (row.revokedAt !== null) throw new UnauthorizedError('Session revoked');
    if (row.expiresAt <= this.nowMs()) throw new UnauthorizedError('Session expired');
    if (row.userId !== principal.userId) throw new UnauthorizedError('Token does not match user');

    const next = await this.issue(principal, deviceId);
    await this.sessions.markReplaced(row.id, next.sessionId);
    return next;
  }

  async revokeAll(userId: string, reason = 'logout_all'): Promise<number> {
    return this.sessions.revokeAllForUser(userId, reason);
  }
}
