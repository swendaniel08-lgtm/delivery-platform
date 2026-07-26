/**
 * Who is signed in, server-side.
 *
 * The layout previously hard-coded `{ role: 'ops_manager' }`, which meant the
 * nav rendered from a constant and RBAC was decorative. This reads the real
 * session cookie and verifies the token with the SAME verifier the services
 * use, so the dashboard cannot show a role the backend will not honour.
 *
 * The nav filtering is still not the security boundary — bff-admin re-checks
 * every call, and admin-svc re-checks after that. Hiding a button stops an
 * accident; it does not stop an attacker.
 */

import 'server-only';
import { cookies } from 'next/headers';

import { verifyAccessToken } from '../../../libs/platform/src/auth/verify';
import type { Principal } from './rbac';

export const SESSION_COOKIE = 'besonc_admin_session';

export class NotSignedInError extends Error {
  constructor() {
    super('not signed in');
    this.name = 'NotSignedInError';
  }
}

export interface Session {
  principal: Principal;
  /** Passed straight through to bff-admin; it re-verifies. */
  token: string;
}

/**
 * The signed-in staff member, or null.
 *
 * Returns null rather than throwing so a page can render a sign-in prompt.
 * Anything that needs a session should call `requireSession`.
 */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) {
    // Refusing is the only safe answer: with no secret we cannot tell a real
    // token from one someone minted themselves.
    throw new Error(
      'JWT_ACCESS_SECRET is not set for the admin dashboard. Without it no '
      + 'session can be verified and every request would have to be trusted.',
    );
  }

  let claims: { sub: string; role: string; zones?: string[] };
  try {
    claims = verifyAccessToken(token, secret) as any;
  } catch {
    // Expired or forged; either way there is no session.
    return null;
  }

  return {
    token,
    principal: {
      id: claims.sub,
      role: claims.role as Principal['role'],
      zones: claims.zones ?? [],
    },
  };
}

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) throw new NotSignedInError();
  return s;
}
