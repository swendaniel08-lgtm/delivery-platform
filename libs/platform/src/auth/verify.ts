/**
 * Access-token verification, shared by every service.
 *
 * identity-svc MINTS tokens; everyone else only verifies them. Duplicating
 * this logic per service is how one of them ends up trusting the `alg`
 * header, so it lives here once.
 *
 * Deliberately standalone (no identity-svc import): a service should not
 * have to depend on the whole identity module to check a signature.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { UnauthorizedError } from '../errors.ts';

export interface AccessClaims {
  sub: string;
  role: string;
  scope?: string;
  vendorId?: string;
  zones?: string[];
  iat: number;
  exp: number;
  jti: string;
}

const b64urlDecode = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Verify an HS256 JWT and return its claims.
 *
 * Throws UnauthorizedError — never returns a partially-trusted result.
 */
export function verifyAccessToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): AccessClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new UnauthorizedError('Malformed token');
  const [header, body, sig] = parts as [string, string, string];

  // Never trust the header's `alg`. Accepting "none" — or letting an
  // attacker downgrade RS256 to HS256 and sign with the public key — is the
  // classic JWT break.
  let head: { alg?: string };
  try { head = JSON.parse(b64urlDecode(header).toString()); }
  catch { throw new UnauthorizedError('Malformed token header'); }
  if (head.alg !== 'HS256') throw new UnauthorizedError('Unsupported token algorithm');

  const expected = b64url(createHmac('sha256', secret).update(`${header}.${body}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new UnauthorizedError('Invalid token signature');
  }

  let claims: AccessClaims;
  try { claims = JSON.parse(b64urlDecode(body).toString()); }
  catch { throw new UnauthorizedError('Malformed token body'); }

  if (typeof claims.exp === 'number' && claims.exp <= nowSeconds) {
    throw new UnauthorizedError('Token expired');
  }
  if (!claims.sub || !claims.role) {
    throw new UnauthorizedError('Token is missing sub or role');
  }
  return claims;
}
