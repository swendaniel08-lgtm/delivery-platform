/** admin BFF + media-svc specs. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  AdminBff, type AdminOrderClient, type MetricsClient,
  type ApprovalClient, type TaskClient, type AdminOrderRow,
} from '../src/bff.ts';
import { InMemoryAuditSink } from '../../svc-admin/src/audit.ts';
import type { Principal } from '../../../libs/auth/src/abilities.ts';
import {
  MediaService, InMemoryStorage, MEDIA_POLICY, KIND_ROLES, buildKey,
  kindFromKey, variantUrl, contentFingerprint, UPLOAD_URL_TTL_SECONDS,
} from '../../svc-media/src/media.ts';
import { fromCedis } from '../../../libs/money/src/money.ts';
import { ForbiddenError, ValidationError, NotFoundError } from '../../../libs/platform/src/errors.ts';

/* ================================================================== */
/* Admin BFF                                                           */
/* ================================================================== */

const superAdmin: Principal = { id: 'a-super', role: 'super_admin' };
const finance: Principal = { id: 'a-fin', role: 'finance' };
const opsOsu: Principal = { id: 'a-ops', role: 'ops_manager', zones: ['accra-osu'] };
const dispatcherOsu: Principal = { id: 'a-dsp', role: 'dispatcher', zones: ['accra-osu'] };
const catalogueEditor: Principal = { id: 'a-cat', role: 'catalogue_editor' };

const order = (over: Partial<AdminOrderRow> = {}): AdminOrderRow => ({
  id: 'o1', humanRef: '#1234', service: 'food', state: 'in_transit',
  zone: 'accra-osu', storeName: "Auntie Adwoa's", riderName: 'Kwame',
  totalPesewas: '8150', createdAt: '2026-07-25T12:00:00Z', ...over,
});

function aHarness(over: { orders?: AdminOrderRow[] } = {}) {
  const listCalls: any[] = [];
  const cancelled: string[] = [];
  const approved: string[] = [];

  const orders: AdminOrderClient = {
    async list(f) { listCalls.push(f); return over.orders ?? [order()]; },
    async get(id) { return (over.orders ?? [order()]).find((o) => o.id === id) ?? null; },
    async forceCancel(id) { cancelled.push(id); },
  };
  const metrics: MetricsClient = {
    async today() {
      return {
        ordersToday: 234, revenuePesewas: fromCedis('12400'), activeRiders: 47,
        activeVendors: 156, cancellationRatePct: 4, unremittedCodPesewas: fromCedis('2300'),
        openTasks: 3,
      };
    },
    async ledgerDrift() { return 0n; },
  };
  const approvals: ApprovalClient = {
    async pendingVendors() { return [{ id: 'v1', name: 'New Shop', submittedAt: 'x' }]; },
    async pendingRiders() { return [{ id: 'r1', name: 'Kofi', vehicle: 'motorbike', submittedAt: 'x' }]; },
    async approveVendor(id) { approved.push(id); },
    async rejectVendor() {},
  };
  const tasks: TaskClient = {
    async open() {
      return [{ id: 't1', kind: 'payout_failed', entityType: 'Payout', entityId: 'p1',
                amountPesewas: '5000', priority: 1, createdAt: 'x' }];
    },
  };
  const sink = new InMemoryAuditSink();
  return {
    bff: new AdminBff(orders, metrics, approvals, tasks, sink),
    sink, listCalls, cancelled, approved,
  };
}

describe('admin dashboard scoping', () => {
  test('a national admin sees everything unscoped', async () => {
    const { bff, listCalls } = aHarness();
    const d = await bff.dashboard(superAdmin);
    assert.equal(d.scope, 'national');
    assert.equal(listCalls[0].zones, undefined);
  });

  test('a zoned admin has the filter applied UPSTREAM', async () => {
    const { bff, listCalls } = aHarness();
    const d = await bff.dashboard(opsOsu);
    assert.equal(d.scope, 'zoned');
    assert.deepEqual(d.zones, ['accra-osu']);
    assert.deepEqual(listCalls[0].zones, ['accra-osu'],
      'out-of-zone rows must never reach the client');
  });

  test('order lists are zone-filtered too, not just the dashboard', async () => {
    const { bff, listCalls } = aHarness();
    await bff.orderList(dispatcherOsu, { states: ['placed'] });
    assert.deepEqual(listCalls[0].zones, ['accra-osu']);
  });

  test('the page size is capped so nobody can request 100k rows', async () => {
    const { bff, listCalls } = aHarness();
    await bff.orderList(superAdmin, { limit: 99_999 });
    assert.equal(listCalls[0].limit, 200);
  });

  test('an out-of-zone order detail is refused', async () => {
    const { bff } = aHarness({ orders: [order({ id: 'o-kumasi', zone: 'kumasi-central' })] });
    await assert.rejects(() => bff.orderDetail(dispatcherOsu, 'o-kumasi'), ForbiddenError);
  });

  test('an in-zone order detail is allowed', async () => {
    const { bff } = aHarness();
    const o = await bff.orderDetail(dispatcherOsu, 'o1');
    assert.equal(o.humanRef, '#1234');
  });
});

describe('admin dashboard content', () => {
  test('metrics, alarms and the task queue are composed in one call', async () => {
    const { bff } = aHarness();
    const d = await bff.dashboard(superAdmin);
    assert.equal(d.metrics.revenueDisplay, 'GHS 12,400.00');
    assert.equal(d.metrics.unremittedCodDisplay, 'GHS 2,300.00');
    assert.equal(d.metrics.ledgerHealthy, true);
    assert.deepEqual(d.alarms, []);
    assert.equal(d.taskQueue[0]!.amountDisplay, 'GHS 50.00');
  });

  test('ledger drift raises a critical alarm', async () => {
    const { bff } = aHarness();
    const broken = new AdminBff(
      { async list() { return []; }, async get() { return null; }, async forceCancel() {} },
      { async today() {
          return { ordersToday: 0, revenuePesewas: 0n, activeRiders: 0, activeVendors: 0,
                   cancellationRatePct: 0, unremittedCodPesewas: 0n, openTasks: 0 };
        },
        async ledgerDrift() { return 500n; } },
      { async pendingVendors() { return []; }, async pendingRiders() { return []; },
        async approveVendor() {}, async rejectVendor() {} },
      { async open() { return []; } },
      new InMemoryAuditSink(),
    );
    const d = await broken.dashboard(superAdmin);
    assert.equal(d.metrics.ledgerHealthy, false);
    assert.ok(d.alarms.some((a) => a.code === 'LEDGER_DRIFT' && a.severity === 'critical'));
  });

  test('approval counts only appear for roles that can act on them', async () => {
    const { bff } = aHarness();
    assert.ok((await bff.dashboard(superAdmin)).pendingApprovals);
    assert.equal((await bff.dashboard(dispatcherOsu)).pendingApprovals, null,
      'a count you cannot clear is just noise');
  });

  test('the task queue is hidden from roles without payment access', async () => {
    const { bff } = aHarness();
    assert.equal((await bff.dashboard(catalogueEditor)).taskQueue.length, 0);
    assert.ok((await bff.dashboard(finance)).taskQueue.length > 0);
  });

  test('a metrics outage still renders the dashboard', async () => {
    const bff = new AdminBff(
      { async list() { return []; }, async get() { return null; }, async forceCancel() {} },
      { async today() { throw new Error('down'); }, async ledgerDrift() { throw new Error('down'); } },
      { async pendingVendors() { return []; }, async pendingRiders() { return []; },
        async approveVendor() {}, async rejectVendor() {} },
      { async open() { return []; } },
      new InMemoryAuditSink(),
    );
    const d = await bff.dashboard(superAdmin);
    assert.equal(d.metrics.orders, 0);
  });
});

describe('audited admin mutations', () => {
  test('force-cancel requires a reason and writes an audit row', async () => {
    const { bff, sink, cancelled } = aHarness();
    await bff.forceCancelOrder(superAdmin, 'o1', 'duplicate order placed by mistake', { ip: '1.2.3.4' });
    assert.deepEqual(cancelled, ['o1']);
    const e = sink.entries[0]!;
    assert.equal(e.action, 'order.force_cancel');
    assert.equal(e.amountPesewas, 8150n);
    assert.equal(e.ip, '1.2.3.4');
    assert.deepEqual(e.beforeState, { state: 'in_transit' });
  });

  test('force-cancel without a reason is refused and nothing is cancelled', async () => {
    const { bff, cancelled } = aHarness();
    await assert.rejects(() => bff.forceCancelOrder(superAdmin, 'o1', ''), ValidationError);
    assert.deepEqual(cancelled, []);
  });

  test('a dispatcher cannot force-cancel outside their zone', async () => {
    const { bff, cancelled } = aHarness({ orders: [order({ zone: 'kumasi-central' })] });
    await assert.rejects(
      () => bff.forceCancelOrder(dispatcherOsu, 'o1', 'customer asked to cancel this'),
      ForbiddenError,
    );
    assert.deepEqual(cancelled, []);
  });

  test('vendor approval is audited without needing a reason', async () => {
    const { bff, sink, approved } = aHarness();
    await bff.approveVendor(catalogueEditor, 'v1');
    assert.deepEqual(approved, ['v1']);
    assert.equal(sink.entries[0]!.action, 'vendor.approve');
  });

  test('a dispatcher cannot approve vendors', async () => {
    const { bff, approved } = aHarness();
    await assert.rejects(() => bff.approveVendor(dispatcherOsu, 'v1'), ForbiddenError);
    assert.deepEqual(approved, []);
  });
});

/* ================================================================== */
/* media-svc                                                           */
/* ================================================================== */

describe('media upload policy', () => {
  const svc = () => new MediaService(new InMemoryStorage());

  test('issues a presigned URL rather than proxying bytes', async () => {
    const r = await svc().requestUpload({
      kind: 'menu_item', contentType: 'image/jpeg', sizeBytes: 2_000_000,
      uploaderId: 'v1', uploaderRole: 'vendor_owner', ownerRef: 'store-1',
    });
    assert.match(r.uploadUrl, /^https:\/\/s3/);
    assert.match(r.objectKey, /^menu_item\/store-1\/[0-9a-f-]+\.jpg$/);
    assert.equal(r.expiresInSeconds, UPLOAD_URL_TTL_SECONDS);
  });

  test('public kinds get a CDN URL, private kinds do not', async () => {
    const pub = await svc().requestUpload({
      kind: 'menu_item', contentType: 'image/jpeg', sizeBytes: 1000,
      uploaderId: 'v1', uploaderRole: 'vendor_owner', ownerRef: 's1',
    });
    assert.match(pub.publicUrl!, /cdn\.besonc\.app/);

    const priv = await svc().requestUpload({
      kind: 'kyc_ghana_card', contentType: 'image/jpeg', sizeBytes: 1000,
      uploaderId: 'r1', uploaderRole: 'rider', ownerRef: 'rider-1',
    });
    assert.equal(priv.publicUrl, null, 'a Ghana Card must never be publicly addressable');
  });

  test('role gating — a customer cannot upload a menu photo', async () => {
    await assert.rejects(() => svc().requestUpload({
      kind: 'menu_item', contentType: 'image/jpeg', sizeBytes: 1000,
      uploaderId: 'c1', uploaderRole: 'customer', ownerRef: 's1',
    }), ForbiddenError);
  });

  test('role gating — only riders upload proof of delivery', async () => {
    await assert.rejects(() => svc().requestUpload({
      kind: 'proof_of_delivery', contentType: 'image/jpeg', sizeBytes: 1000,
      uploaderId: 'c1', uploaderRole: 'customer', ownerRef: 'o1',
    }), ForbiddenError);
  });

  test('only customers upload prescriptions', () => {
    assert.deepEqual(KIND_ROLES.prescription, ['customer']);
  });

  test('oversized uploads are rejected before a URL is issued', async () => {
    const storage = new InMemoryStorage();
    await assert.rejects(() => new MediaService(storage).requestUpload({
      kind: 'proof_of_delivery', contentType: 'image/jpeg', sizeBytes: 50_000_000,
      uploaderId: 'r1', uploaderRole: 'rider', ownerRef: 'o1',
    }), ValidationError);
    assert.deepEqual(storage.puts, [], 'no URL should have been minted');
  });

  test('rider proof photos are capped tighter than menu photos', () => {
    assert.ok(MEDIA_POLICY.proof_of_delivery.maxBytes < MEDIA_POLICY.menu_item.maxBytes);
  });

  test('content types are enforced per kind', async () => {
    await assert.rejects(() => svc().requestUpload({
      kind: 'menu_item', contentType: 'application/pdf', sizeBytes: 1000,
      uploaderId: 'v1', uploaderRole: 'vendor_owner', ownerRef: 's1',
    }), ValidationError);

    // a prescription may legitimately be a PDF
    await svc().requestUpload({
      kind: 'prescription', contentType: 'application/pdf', sizeBytes: 1000,
      uploaderId: 'c1', uploaderRole: 'customer', ownerRef: 'o1',
    });
  });

  test('executables and svg are never allowed', async () => {
    for (const ct of ['image/svg+xml', 'application/x-msdownload', 'text/html']) {
      await assert.rejects(() => svc().requestUpload({
        kind: 'menu_item', contentType: ct, sizeBytes: 1000,
        uploaderId: 'v1', uploaderRole: 'vendor_owner', ownerRef: 's1',
      }), ValidationError, `${ct} must be rejected`);
    }
  });

  test('the owner reference is sanitised into the key', () => {
    const key = buildKey({
      kind: 'chat_image', contentType: 'image/png', sizeBytes: 1,
      uploaderId: 'u', uploaderRole: 'customer', ownerRef: '../../etc/passwd',
    });
    assert.equal(key.includes('..'), false, 'path traversal must not survive');
    assert.match(key, /^chat_image\//);
  });
});

describe('media retention and access', () => {
  test('private objects get a short-lived signed GET', async () => {
    const url = await new MediaService(new InMemoryStorage())
      .viewUrl('kyc_ghana_card/rider-1/abc.jpg');
    assert.match(url, /s3\.test\/get/);
  });

  test('public objects are served straight from the CDN', async () => {
    const url = await new MediaService(new InMemoryStorage())
      .viewUrl('menu_item/store-1/abc.jpg');
    assert.match(url, /cdn\.besonc\.app/);
  });

  test('retention windows differ by sensitivity', () => {
    const svc = new MediaService(new InMemoryStorage());
    const now = new Date('2026-07-25T00:00:00Z');
    assert.equal(svc.expiredBefore('menu_item', now), null, 'menu photos are kept');
    const pod = svc.expiredBefore('proof_of_delivery', now)!;
    assert.equal(pod.toISOString().slice(0, 10), '2025-07-25', 'POD kept 1 year');
    const kyc = svc.expiredBefore('kyc_ghana_card', now)!;
    assert.ok(kyc < pod, 'KYC is kept far longer for compliance');
  });

  test('kind is recoverable from the key for lifecycle rules', () => {
    assert.equal(kindFromKey('proof_of_delivery/o1/x.jpg'), 'proof_of_delivery');
    assert.equal(kindFromKey('nonsense/x.jpg'), null);
  });
});

describe('image variants', () => {
  test('an 8MB vendor photo is never sent to a phone as-is', () => {
    const url = variantUrl('https://cdn.besonc.app/menu_item/s1/a.jpg', 'card');
    assert.match(url, /w=480/);
    assert.match(url, /fm=webp/);
  });

  test('unknown variants are rejected', () => {
    assert.throws(() => variantUrl('https://cdn/x.jpg', 'gigantic'), ValidationError);
  });

  test('identical images fingerprint identically for de-duplication', () => {
    const a = contentFingerprint(Buffer.from('same-bytes'));
    const b = contentFingerprint(Buffer.from('same-bytes'));
    const c = contentFingerprint(Buffer.from('different'));
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});
