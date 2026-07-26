/**
 * Firebase Cloud Messaging, HTTP v1.
 *
 * The legacy `/fcm/send` endpoint took a static server key and is gone. v1
 * requires a short-lived OAuth2 access token minted from a service-account
 * key by signing a JWT with RS256. That is the bulk of this file, and the
 * reason it is not three lines.
 *
 * No `firebase-admin`: it pulls in gRPC and ~200 modules for one POST, and
 * this image already runs fifteen services. `node:crypto` signs RS256.
 *
 * Three behaviours matter more than "does the POST succeed":
 *
 *   1. **Token expiry is cached, not re-minted per message.** At dinner-time
 *      peak we send thousands of pushes a minute; minting an OAuth token for
 *      each would add a round trip to Google in front of every notification
 *      and hit their quota.
 *   2. **Dead tokens must be REPORTED, not just failed.** A phone that was
 *      reinstalled keeps its row in our table forever, and we keep paying
 *      the round trip. `UNREGISTERED` / `INVALID_ARGUMENT` come back as a
 *      typed error the caller can act on by deleting the token.
 *   3. **Retryable vs permanent must be distinguishable.** Retrying a
 *      permanent failure burns quota; not retrying a transient one loses the
 *      "your rider has arrived" push, and the customer's food goes cold at
 *      the gate.
 */

import { createSign } from 'node:crypto';
import { UpstreamError } from '../../../../libs/platform/src/errors.ts';
import type { PushMessage, PushProvider } from '../dispatcher.ts';

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface FcmConfig {
  serviceAccount: ServiceAccount;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * A token FCM told us is dead. The caller should delete it — this is the
 * only signal we ever get that an app was uninstalled.
 */
export class PushTokenInvalidError extends Error {
  readonly token: string;
  constructor(token: string, reason: string) {
    super(`push token is no longer valid (${reason})`);
    this.name = 'PushTokenInvalidError';
    this.token = token;
  }
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

/** FCM v1 error codes that mean "this token will never work again". */
const DEAD_TOKEN_CODES = new Set(['UNREGISTERED', 'INVALID_ARGUMENT', 'NOT_FOUND', 'SENDER_ID_MISMATCH']);
/** Codes worth another attempt. */
const RETRYABLE_CODES = new Set(['UNAVAILABLE', 'INTERNAL', 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED']);

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Parses FIREBASE_SERVICE_ACCOUNT_JSON.
 *
 * The `\n`-escaping of `private_key` is the classic deployment trap: pasted
 * through a shell or a secrets UI the newlines arrive literal, RS256 signing
 * fails with an opaque OpenSSL error, and it looks like a bad key. Normalise
 * here and validate loudly.
 */
export function parseServiceAccount(raw: string): ServiceAccount {
  let json: any;
  try { json = JSON.parse(raw); }
  catch {
    // Some secret managers hand back base64 rather than JSON.
    try { json = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
    catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is neither JSON nor base64-encoded JSON'); }
  }

  for (const f of ['project_id', 'client_email', 'private_key'] as const) {
    if (!json[f]) throw new Error(`Firebase service account is missing "${f}"`);
  }

  const private_key = String(json.private_key).replace(/\\n/g, '\n');
  if (!private_key.includes('BEGIN PRIVATE KEY')) {
    throw new Error(
      'Firebase private_key does not look like a PEM key. If it was pasted '
      + 'through a shell, the \\n escapes may have been mangled.',
    );
  }

  return {
    project_id: String(json.project_id),
    client_email: String(json.client_email),
    private_key,
    token_uri: json.token_uri ? String(json.token_uri) : DEFAULT_TOKEN_URI,
  };
}

export class FcmPushProvider implements PushProvider {
  readonly name = 'fcm';

  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly clock: () => number;

  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  /** In-flight mint, so a burst of sends produces ONE token request. */
  private minting: Promise<string> | null = null;

  constructor(private readonly cfg: FcmConfig) {
    this.doFetch = cfg.fetchImpl ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? 5_000;
    this.clock = cfg.now ?? Date.now;
  }

  /* ---------------------------------------------------------------- */
  /* OAuth2                                                            */
  /* ---------------------------------------------------------------- */

  /** Signs the service-account assertion. */
  private signAssertion(): string {
    const iat = Math.floor(this.clock() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(JSON.stringify({
      iss: this.cfg.serviceAccount.client_email,
      scope: SCOPE,
      aud: this.cfg.serviceAccount.token_uri ?? DEFAULT_TOKEN_URI,
      iat,
      exp: iat + 3600,
    }));
    const signature = createSign('RSA-SHA256')
      .update(`${header}.${claims}`)
      .sign(this.cfg.serviceAccount.private_key)
      .toString('base64url');
    return `${header}.${claims}.${signature}`;
  }

  /**
   * A valid access token, minted at most once per hour.
   *
   * The 60-second safety margin matters: a token that expires mid-flight
   * fails as 401, and at peak that is thousands of pushes lost to a clock
   * difference of a few seconds.
   */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && this.clock() < this.accessTokenExpiresAt - 60_000) {
      return this.accessToken;
    }
    // Collapse a concurrent burst into a single mint.
    if (this.minting) return this.minting;

    this.minting = this.mint().finally(() => { this.minting = null; });
    return this.minting;
  }

  private async mint(): Promise<string> {
    const uri = this.cfg.serviceAccount.token_uri ?? DEFAULT_TOKEN_URI;
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: this.signAssertion(),
    });

    const res = await this.fetchWithTimeout(uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, 'fcm-oauth');

    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      // A rejected assertion nearly always means a clock skew, a revoked key,
      // or the Firebase Cloud Messaging API not being enabled on the project.
      throw new UpstreamError(
        'fcm-oauth',
        `could not mint an FCM access token (HTTP ${res.status}): `
        + `${json.error_description ?? json.error ?? 'unknown'}`,
      );
    }

    this.accessToken = String(json.access_token);
    this.accessTokenExpiresAt = this.clock() + Number(json.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  /* ---------------------------------------------------------------- */
  /* Send                                                              */
  /* ---------------------------------------------------------------- */

  async send(msg: PushMessage): Promise<{ messageId: string }> {
    const token = await this.getAccessToken();
    const url = `https://fcm.googleapis.com/v1/projects/${this.cfg.serviceAccount.project_id}/messages:send`;

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: this.buildMessage(msg) }),
    }, 'fcm');

    const json: any = await res.json().catch(() => ({}));

    if (res.ok && json.name) {
      return { messageId: String(json.name) };
    }

    const code = errorCode(json);

    if (DEAD_TOKEN_CODES.has(code)) {
      // Surfaced as its own type so the caller prunes the row rather than
      // retrying a token that will never work again.
      throw new PushTokenInvalidError(msg.token, code);
    }

    if (res.status === 401 || res.status === 403) {
      // Force a re-mint; the cached token may have been revoked early.
      this.accessToken = null;
      throw new UpstreamError('fcm', `FCM rejected our credentials (HTTP ${res.status})`);
    }

    throw new UpstreamError(
      'fcm',
      `FCM send failed (HTTP ${res.status}, ${code}): `
      + `${json.error?.message ?? 'no detail'}`,
    );
  }

  /**
   * Builds the v1 payload.
   *
   * The Android/APNs blocks are not decoration. A "your rider has arrived"
   * notification that waits for the OS to batch it is worthless — the rider
   * is at the gate NOW. Critical messages therefore ask for high priority
   * and, on iOS, an interruption level that shows through Focus modes.
   */
  private buildMessage(msg: PushMessage): Record<string, unknown> {
    return {
      token: msg.token,
      notification: { title: msg.title, body: msg.body },
      // Data must be strings — FCM rejects the whole message on a number.
      data: {
        ...(msg.deepLink ? { deepLink: msg.deepLink } : {}),
        critical: String(msg.critical),
      },
      android: {
        priority: msg.critical ? 'HIGH' : 'NORMAL',
        // Collapse non-critical pushes so a phone that was offline through
        // six status changes wakes to the latest one, not to six.
        ...(msg.critical ? {} : { collapse_key: 'besonc_status' }),
        notification: {
          channel_id: msg.critical ? 'besonc_critical' : 'besonc_updates',
          // Ghana is UTC; no offset juggling needed for the TTL.
          ...(msg.critical ? {} : { notification_priority: 'PRIORITY_DEFAULT' }),
        },
        // A status update that arrives an hour late is noise. Let it die.
        ttl: msg.critical ? '600s' : '3600s',
      },
      apns: {
        headers: {
          'apns-priority': msg.critical ? '10' : '5',
          'apns-push-type': 'alert',
        },
        payload: {
          aps: {
            sound: msg.critical ? 'default' : undefined,
            'interruption-level': msg.critical ? 'time-sensitive' : 'active',
          },
        },
      },
    };
  }

  private async fetchWithTimeout(
    url: string, init: RequestInit, upstream: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.doFetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError') {
        throw new UpstreamError(upstream, `timed out after ${this.timeoutMs}ms`);
      }
      throw new UpstreamError(upstream, e.message);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** FCM nests the machine-readable code inside error.details. */
export function errorCode(body: any): string {
  const detail = (body?.error?.details ?? []).find(
    (d: any) => typeof d?.errorCode === 'string',
  );
  return detail?.errorCode ?? body?.error?.status ?? 'UNKNOWN';
}

export function isRetryable(code: string): boolean {
  return RETRYABLE_CODES.has(code);
}
