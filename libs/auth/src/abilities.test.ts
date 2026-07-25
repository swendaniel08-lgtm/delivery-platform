/** rbac.spec — proves the 9 admin roles and 4 app roles are correctly scoped. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { can, type Principal } from './abilities.ts';

const P = (role: Principal['role'], extra: Partial<Principal> = {}): Principal =>
  ({ id: 'u1', role, ...extra });

describe('super_admin', () => {
  test('can do anything', () => {
    const a = P('super_admin');
    assert.ok(can(a, 'manage', 'all'));
    assert.ok(can(a, 'refund', 'Payment'));
    assert.ok(can(a, 'delete', 'Vendor'));
  });
});

describe('separation of duties — money', () => {
  test('ops_manager cannot refund or pay out', () => {
    const a = P('ops_manager');
    assert.ok(can(a, 'read', 'Payment'));
    assert.equal(can(a, 'refund', 'Payment'), false);
    assert.equal(can(a, 'payout', 'Payment'), false);
  });

  test('support cannot refund — must escalate', () => {
    const a = P('support');
    assert.ok(can(a, 'read', 'Payment'));
    assert.equal(can(a, 'refund', 'Payment'), false);
  });

  test('finance can refund and pay out', () => {
    const a = P('finance');
    assert.ok(can(a, 'refund', 'Payment'));
    assert.ok(can(a, 'payout', 'Payout'));
  });

  test('nobody may mutate the ledger — not even finance', () => {
    assert.equal(can(P('finance'), 'update', 'Ledger'), false);
    assert.equal(can(P('finance'), 'delete', 'Ledger'), false);
    assert.ok(can(P('finance'), 'read', 'Ledger'));
  });
});

describe('zone scoping', () => {
  test('dispatcher is limited to assigned zones', () => {
    const d = P('dispatcher', { zones: ['accra-osu'] });
    assert.ok(can(d, 'update', 'Order', { zone: 'accra-osu' }));
    assert.equal(can(d, 'update', 'Order', { zone: 'kumasi-central' }), false);
  });
});

describe('tenant isolation', () => {
  test('vendor sees only its own orders', () => {
    const v = P('vendor_owner', { vendorId: 'v1' });
    assert.ok(can(v, 'read', 'Order', { vendorId: 'v1' }));
    assert.equal(can(v, 'read', 'Order', { vendorId: 'v2' }), false);
  });

  test('vendor_staff cannot manage the vendor record itself', () => {
    const s = P('vendor_staff', { vendorId: 'v1' });
    assert.ok(can(s, 'update', 'Order', { vendorId: 'v1' }));
    assert.equal(can(s, 'update', 'Vendor', { id: 'v1' }), false);
  });

  test('customer sees only their own orders', () => {
    const c = P('customer');
    assert.ok(can(c, 'read', 'Order', { customerId: 'u1' }));
    assert.equal(can(c, 'read', 'Order', { customerId: 'other' }), false);
  });

  test('rider sees only assigned orders', () => {
    const r = P('rider');
    assert.ok(can(r, 'update', 'Order', { riderId: 'u1' }));
    assert.equal(can(r, 'update', 'Order', { riderId: 'other' }), false);
  });
});

describe('least privilege', () => {
  test('read_only cannot mutate anything', () => {
    const a = P('read_only');
    assert.ok(can(a, 'read', 'Order'));
    for (const act of ['create', 'update', 'delete', 'approve', 'refund'] as const) {
      assert.equal(can(a, act, 'Order'), false, `read_only must not ${act}`);
    }
  });

  test('catalogue_editor cannot touch payments', () => {
    const a = P('catalogue_editor');
    assert.ok(can(a, 'manage', 'Catalogue'));
    assert.equal(can(a, 'read', 'Payment'), false);
  });

  test('customer cannot read the admin audit log', () => {
    assert.equal(can(P('customer'), 'read', 'AuditLog'), false);
  });
});
