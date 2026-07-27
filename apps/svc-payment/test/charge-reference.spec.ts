/**
 * Charge references must round-trip.
 *
 * This file exists because they did not, and the failure was silent and
 * financial.
 *
 *   chargeReference()  emitted   ord_<32 hex>_a1
 *   orderIdFrom()      parsed    /^order:([^:]+):/
 *
 * So every genuine charge.success from Paystack hit `orderIdFrom` returning
 * null, logged "unrecognised reference", and returned BEFORE ledger.capture().
 * The customer is charged; the platform never records it. Nothing throws,
 * nothing 500s, and the only trace is a console.warn.
 *
 * Found by pushing a real Paystack webhook end to end and then looking at the
 * ledger table, which was empty. No unit test could have caught it, because
 * both halves were individually correct — they just described different
 * formats.
 *
 * Also pinned here: Paystack's own reference rules, learned from the live
 * sandbox rather than the docs. A colon is rejected with
 * "Invalid character in transaction reference".
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  chargeReference, orderIdFromReference,
} from '../src/paystack/client.ts';

const ORDER = '3f2a9c1e-4b7d-4c8a-9e1f-2b6d8a4c0e91';

describe('the round trip', () => {
  test('a generated reference parses back to the same order id', () => {
    // The property the whole payment path depends on.
    assert.equal(orderIdFromReference(chargeReference(ORDER, 1)), ORDER);
  });

  test('every retry attempt still yields the same order', () => {
    for (const attempt of [1, 2, 3, 10, 99]) {
      assert.equal(
        orderIdFromReference(chargeReference(ORDER, attempt)), ORDER,
        `attempt ${attempt} lost the order id`,
      );
    }
  });

  test('different orders never collide', () => {
    const a = chargeReference('11111111-1111-4111-8111-111111111111', 1);
    const b = chargeReference('22222222-2222-4222-8222-222222222222', 1);
    assert.notEqual(a, b);
    assert.notEqual(orderIdFromReference(a), orderIdFromReference(b));
  });

  test('attempts of one order are distinct references', () => {
    // Paystack rejects a duplicate reference, so a retry must differ.
    assert.notEqual(chargeReference(ORDER, 1), chargeReference(ORDER, 2));
  });
});

describe("Paystack's reference rules (verified against the live sandbox)", () => {
  test('only alphanumerics and - . = are permitted', () => {
    // A colon returns "Invalid character in transaction reference". This is a
    // runtime rejection with no type to catch it, so the generator must be
    // asserted directly.
    const ref = chargeReference(ORDER, 1);
    assert.match(ref, /^[A-Za-z0-9\-.=_]+$/,
      `"${ref}" contains a character Paystack refuses`);
  });

  test('no colon, whatever the input', () => {
    // The exact character that broke it.
    assert.ok(!chargeReference(ORDER, 1).includes(':'));
  });

  test('references stay within a sane length', () => {
    assert.ok(chargeReference(ORDER, 1).length < 100);
  });
});

describe('rejecting references that are not ours', () => {
  for (const bad of [
    'order:abc:1',            // the format the parser WRONGLY expected
    'besonc-live-1785185038', // an ad-hoc test reference
    'ord_short_a1',
    'ord_3f2a9c1e4b7d4c8a9e1f2b6d8a4c0e91',   // no attempt
    'ord_3f2a9c1e4b7d4c8a9e1f2b6d8a4c0e91_a', // empty attempt
    '',
    'ord__a1',
  ]) {
    test(`"${bad}" is not one of ours`, () => {
      assert.equal(orderIdFromReference(bad), null);
    });
  }

  test('a non-hex body is refused', () => {
    // Otherwise a crafted reference could name an order id we never issued.
    assert.equal(
      orderIdFromReference('ord_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz_a1'), null,
    );
  });
});

describe('the recovered id is a real UUID', () => {
  test('hyphenation is restored 8-4-4-4-12', () => {
    // ledger.capture() takes a uuid; an unhyphenated string would fail at
    // the database with a type error rather than here.
    const recovered = orderIdFromReference(chargeReference(ORDER, 1))!;
    assert.match(
      recovered,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  test('case is preserved through the round trip', () => {
    const upper = '3F2A9C1E-4B7D-4C8A-9E1F-2B6D8A4C0E91';
    assert.equal(
      orderIdFromReference(chargeReference(upper, 1))!.toLowerCase(),
      upper.toLowerCase(),
    );
  });
});
