/**
 * Paystack source-IP allowlist.
 *
 * From the docs (paystack.com/docs/payments/webhooks — "Verify event origin"),
 * which name signature validation AND IP whitelisting as the two ways to
 * confirm an event came from Paystack. We had the first only.
 *
 * The signature remains the real defence: an attacker who cannot compute a
 * valid HMAC-SHA512 cannot forge an event from any address. This exists for
 * the case that actually worries me — a secret key leaking via a log, a
 * backup or a screenshot. Leaked key with no IP check is a free order.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PAYSTACK_WEBHOOK_IPS, clientIpFrom, isPaystackIp, shouldEnforce,
} from '../src/paystack/source-ip.ts';

describe('the documented addresses', () => {
  test('exactly the three Paystack publishes', () => {
    // Pinned deliberately. If Paystack changes this list our webhooks start
    // failing, and a failing test naming the source is a much shorter debug
    // than a silent 401 loop.
    assert.deepEqual([...PAYSTACK_WEBHOOK_IPS], [
      '52.31.139.75', '52.49.173.169', '52.214.14.220',
    ]);
  });

  test('the same list serves test and live', () => {
    // Documented as domain-independent — no per-environment list to drift.
    for (const ip of PAYSTACK_WEBHOOK_IPS) assert.equal(isPaystackIp(ip), true);
  });

  test('anything else is not Paystack', () => {
    for (const ip of ['52.31.139.76', '1.2.3.4', '127.0.0.1', '', 'not-an-ip']) {
      assert.equal(isPaystackIp(ip), false, `${ip} was accepted`);
    }
  });

  test('null is not Paystack', () => {
    assert.equal(isPaystackIp(null), false);
  });
});

describe('resolving the client address', () => {
  test('uses the socket peer when there is no proxy', () => {
    assert.equal(clientIpFrom('52.31.139.75', undefined), '52.31.139.75');
  });

  test('prefers x-forwarded-for behind a proxy', () => {
    // Behind ngrok or a load balancer the socket peer is the PROXY, so the
    // socket address alone would never match and enforcement would reject
    // every genuine event.
    assert.equal(clientIpFrom('10.0.0.5', '52.31.139.75'), '52.31.139.75');
  });

  test('takes the LEFTMOST entry of a forwarded chain', () => {
    // The chain is client, then each proxy. The original client is first.
    assert.equal(
      clientIpFrom('10.0.0.5', '52.31.139.75, 10.0.0.5, 172.16.0.1'),
      '52.31.139.75',
    );
  });

  test('tolerates the spacing real proxies emit', () => {
    assert.equal(clientIpFrom('10.0.0.5', '  52.49.173.169 ,10.0.0.5'), '52.49.173.169');
  });

  test('unwraps IPv4-mapped IPv6', () => {
    // Node reports ::ffff:x.x.x.x on a dual-stack socket; without unwrapping
    // no comparison ever matches.
    assert.equal(clientIpFrom('::ffff:52.31.139.75', undefined), '52.31.139.75');
  });

  test('null when nothing is known', () => {
    assert.equal(clientIpFrom(undefined, undefined), null);
    assert.equal(clientIpFrom('', ''), null);
  });

  test('AN ATTACKER CAN FORGE x-forwarded-for', () => {
    // This is the whole reason IP checking is defence in depth and never the
    // primary control. Behind an untrusted proxy the header is attacker
    // -controlled, so it must not be able to authorise anything on its own.
    const spoofed = clientIpFrom('203.0.113.9', '52.31.139.75');
    assert.equal(isPaystackIp(spoofed), true,
      'the header is trusted by design — which is why the SIGNATURE decides');
  });
});

describe('enforcement is opt-in', () => {
  test('off by default', () => {
    // In development the peer is the tunnel, so every genuine event looks
    // like 127.0.0.1. A control that blocks real payments by default is
    // worse than no control.
    assert.equal(shouldEnforce({}), false);
    assert.equal(shouldEnforce({ PAYSTACK_ENFORCE_IP_ALLOWLIST: '' }), false);
    assert.equal(shouldEnforce({ PAYSTACK_ENFORCE_IP_ALLOWLIST: 'false' }), false);
  });

  test('on when explicitly set', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes']) {
      assert.equal(shouldEnforce({ PAYSTACK_ENFORCE_IP_ALLOWLIST: v }), true, v);
    }
  });
});
