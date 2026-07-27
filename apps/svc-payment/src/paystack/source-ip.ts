/**
 * Paystack source-IP allowlist.
 *
 * Straight from the docs (paystack.com/docs/payments/webhooks — "Verify event
 * origin"), which name signature validation and IP whitelisting as the two
 * ways to confirm an event is genuinely from Paystack. We had the first and
 * not the second.
 *
 * The signature is the real defence — an attacker who cannot compute a valid
 * HMAC cannot forge an event whatever their IP. This is defence in depth for
 * the case that actually worries me: a secret key leaking through a log, a
 * backup, or a screenshot. A leaked key plus no IP check is a free order; a
 * leaked key plus this is a free order only from three AWS eu-west-1
 * addresses.
 *
 * Documented as identical for test and live, so there is no per-environment
 * list to keep in step.
 */

/** The three addresses Paystack documents as its webhook sources. */
export const PAYSTACK_WEBHOOK_IPS = [
  '52.31.139.75',
  '52.49.173.169',
  '52.214.14.220',
] as const;

/**
 * Normalise what a proxy hands us.
 *
 * Behind ngrok, a load balancer or Cloudflare the socket address is the
 * PROXY, not Paystack, and the origin arrives in `x-forwarded-for` as a
 * comma-separated chain. The leftmost entry is the original client — but it
 * is also client-controlled, which is exactly why this must never be the only
 * check. IPv4-mapped IPv6 (`::ffff:52.31.139.75`) is unwrapped because Node
 * reports it that way on a dual-stack socket.
 */
export function clientIpFrom(
  socketIp: string | undefined,
  forwardedFor: string | undefined,
): string | null {
  const first = (forwardedFor ?? '').split(',')[0]?.trim();
  const raw = first || socketIp || '';
  if (!raw) return null;
  return raw.replace(/^::ffff:/, '');
}

export function isPaystackIp(ip: string | null): boolean {
  if (!ip) return false;
  return (PAYSTACK_WEBHOOK_IPS as readonly string[]).includes(ip);
}

/**
 * Should we REFUSE this request outright?
 *
 * Deliberately not the default. Enforcing the allowlist is correct in
 * production behind a trusted proxy, and wrong almost everywhere else:
 *
 *   • In development the tunnel (ngrok) is the peer, so every genuine event
 *     appears to come from 127.0.0.1 and enforcing would reject all of them.
 *   • Behind an UNTRUSTED proxy, `x-forwarded-for` is attacker-controlled, so
 *     enforcing gives false confidence rather than protection.
 *
 * So: log the mismatch always, refuse only when explicitly switched on. A
 * silent security control that blocks real payments is worse than none.
 */
export function shouldEnforce(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes)$/i.test(env.PAYSTACK_ENFORCE_IP_ALLOWLIST ?? '');
}
