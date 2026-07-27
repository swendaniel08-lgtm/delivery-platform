/**
 * Admin action authorisation.
 *
 * This file exists because of a privilege escalation found by exploit against
 * a running service.
 *
 * `POST /admin/actions` REQUIRED the caller to send `ability` and `subject`,
 * and then evaluated the permission gate against those values. So the caller
 * was choosing which permission to check:
 *
 *   read_only admin ->
 *     { "action": "payment.refund", "ability": "read", "subject": "Report", … }
 *   -> 201, refund recorded
 *
 * Asking the caller which permission to verify is the same as not verifying.
 * The action name is now the only thing the caller picks; what it REQUIRES is
 * a server-side table.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  permissionFor, ACTION_PERMISSIONS, UnknownActionError,
  REASON_REQUIRED_ACTIONS,
} from '../src/audit.ts';
import { can, type Principal } from '../../../libs/auth/src/abilities.ts';

const p = (role: string): Principal => ({ id: `${role}-1`, role: role as any, zones: [] });

/* ------------------------------------------------------------------ */

describe('the permission is derived, not supplied', () => {
  test('every action maps to a fixed ability and subject', () => {
    const refund = permissionFor('payment.refund');
    assert.deepEqual(refund, { ability: 'refund', subject: 'Payment' });
  });

  test('an unregistered action is REFUSED, not defaulted', () => {
    // A new action must be a deliberate entry. Defaulting to something
    // permissive is how an unreviewed endpoint becomes an open one.
    assert.throws(() => permissionFor('payment.drain_all'), UnknownActionError);
    assert.throws(() => permissionFor(''), UnknownActionError);
    assert.throws(() => permissionFor('__proto__'), UnknownActionError);
  });

  test('every reason-requiring action is in the registry', () => {
    // The two tables must not drift: an action that demands a written reason
    // is by definition consequential, so it must also have a permission.
    for (const action of REASON_REQUIRED_ACTIONS) {
      assert.ok(ACTION_PERMISSIONS[action],
        `${action} requires a reason but has no permission entry`);
    }
  });

  test('no action is registered against a wildcard subject', () => {
    // `all` would quietly satisfy any rule granting manage:all.
    for (const [action, perm] of Object.entries(ACTION_PERMISSIONS)) {
      assert.notEqual(perm.subject, 'all', `${action} is registered against 'all'`);
    }
  });
});

/* ------------------------------------------------------------------ */

describe('THE ESCALATION: a weak role cannot buy a strong permission', () => {
  test('read_only cannot refund, whatever it claims', () => {
    const perm = permissionFor('payment.refund');
    assert.equal(can(p('read_only'), perm.ability, perm.subject), false);

    // The exploit was to send ability=read/subject=Report alongside a refund.
    // That combination is now simply never consulted — but assert the shape
    // of the lie is itself harmless, so the fix cannot regress into reading
    // the body again without this failing.
    assert.equal(can(p('read_only'), 'read', 'Report'), true);
    assert.notDeepEqual(perm, { ability: 'read', subject: 'Report' });
  });

  test('support cannot refund', () => {
    const perm = permissionFor('payment.refund');
    assert.equal(can(p('support'), perm.ability, perm.subject), false);
  });

  test('ops_manager cannot refund — money is finance', () => {
    const perm = permissionFor('payment.refund');
    assert.equal(can(p('ops_manager'), perm.ability, perm.subject), false);
  });

  test('finance CAN refund', () => {
    const perm = permissionFor('payment.refund');
    assert.equal(can(p('finance'), perm.ability, perm.subject), true);
  });

  test('ops_manager can suspend a rider, finance cannot', () => {
    // Operational and financial authority are genuinely separate.
    const perm = permissionFor('rider.suspend');
    assert.equal(can(p('ops_manager'), perm.ability, perm.subject), true);
    assert.equal(can(p('finance'), perm.ability, perm.subject), false);
  });

  test('read_only can perform NOTHING in the registry', () => {
    // The role name is a promise; check it holds across every action.
    for (const [action, perm] of Object.entries(ACTION_PERMISSIONS)) {
      assert.equal(
        can(p('read_only'), perm.ability, perm.subject), false,
        `read_only was permitted to ${action}`,
      );
    }
  });

  test('a dispatcher cannot touch money or pricing', () => {
    for (const action of ['payment.refund', 'payment.payout', 'pricing.update']) {
      const perm = permissionFor(action);
      assert.equal(can(p('dispatcher'), perm.ability, perm.subject), false,
        `dispatcher was permitted to ${action}`);
    }
  });

  test('a non-staff role is not an admin at all', () => {
    for (const role of ['customer', 'rider', 'vendor_owner']) {
      const perm = permissionFor('payment.refund');
      assert.equal(can(p(role), perm.ability, perm.subject), false);
    }
  });
});
