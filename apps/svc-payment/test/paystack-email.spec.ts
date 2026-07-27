/**
 * Paystack email validation.
 *
 * Written from what the LIVE sandbox actually did, not from the docs.
 *
 * Paystack refuses reserved TLDs — `.test`, `.local`, `.invalid` — with a
 * bare "Invalid Email Address Passed". No field name, no hint. The first
 * time we ran against a real key, our own probe used `customer@besonc.test`
 * and was rejected, and the message reads like a credentials problem rather
 * than a data one.
 *
 * Confirmed against the sandbox on the same run:
 *
 *   customer@besonc.test                          -> Invalid Email Address Passed
 *   <uuid>@customers.besonc.app                   -> Authorization URL created
 *   0244123456@customers.besonc.app               -> Authorization URL created
 *
 * So production is correct — the customer BFF synthesises
 * `<userId>@customers.besonc.app` because Ghanaian customers sign up with a
 * phone and have no email. This guard exists so a future change to that
 * scheme fails at the call site with an explanation, instead of at Paystack
 * with a shrug.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { assertPaystackEmail } from '../src/paystack/client.ts';
import { ValidationError } from '../../../libs/platform/src/errors.ts';

describe('addresses Paystack accepts', () => {
  test('the address production actually sends', () => {
    // Verified live: this exact shape returned "Authorization URL created".
    assertPaystackEmail('3f2a9c1e-4b7d-4c8a-9e1f-2b6d8a4c0e91@customers.besonc.app');
  });

  test('a phone-derived local part', () => {
    assertPaystackEmail('0244123456@customers.besonc.app');
  });

  test('an ordinary customer address', () => {
    assertPaystackEmail('ama.mensah@gmail.com');
  });
});

describe('addresses Paystack REJECTS', () => {
  for (const bad of [
    'customer@besonc.test',
    'someone@besonc.local',
    'someone@nowhere.invalid',
    'someone@foo.example',
    'root@localhost',
  ]) {
    test(`${bad} is refused before we call Paystack`, () => {
      // Failing here names the problem. Failing at Paystack does not.
      assert.throws(() => assertPaystackEmail(bad), (e: unknown) => {
        assert.ok(e instanceof ValidationError);
        // ValidationError carries field detail in `extra`, not `message` —
        // `message` is the generic "Request validation failed". Asserting on
        // message alone passed for the wrong reason on my first attempt.
        const detail = JSON.stringify((e as ValidationError).extra);
        assert.match(detail, /reserved TLD|not a valid email/);
        return true;
      });
    });
  }

  test('the error explains WHY, not just that it failed', () => {
    try {
      assertPaystackEmail('customer@besonc.test');
      assert.fail('should have thrown');
    } catch (e) {
      const msg = JSON.stringify((e as ValidationError).extra);
      // The whole point: whoever hits this must not spend an afternoon
      // suspecting their API key.
      assert.match(msg, /Invalid Email Address Passed|reserved TLD/);
    }
  });
});

describe('malformed input', () => {
  for (const bad of ['', 'not-an-email', '@besonc.app', 'someone@', 'a b@c.com']) {
    test(`"${bad}" is rejected`, () => {
      assert.throws(() => assertPaystackEmail(bad), ValidationError);
    });
  }

  test('case and surrounding space do not smuggle a reserved TLD past', () => {
    assert.throws(() => assertPaystackEmail('  Customer@Besonc.TEST  '), ValidationError);
  });
});
