import { formatCedis } from '../../lib/format';

interface AuditRow {
  id: string; actorRole: string; action: string; entityType: string;
  entityId: string; amountPesewas: string | null; reason: string | null; createdAt: string;
}

async function getAudit(): Promise<AuditRow[]> {
  return [
    { id: '1', actorRole: 'finance', action: 'payment.refund', entityType: 'Payment',
      entityId: 'pay-8821', amountPesewas: '8150',
      reason: 'customer never received the order', createdAt: '2026-07-25 11:42' },
    { id: '2', actorRole: 'ops_manager', action: 'vendor.suspend', entityType: 'Vendor',
      entityId: 'ven-104', amountPesewas: null,
      reason: 'repeated auto-rejections, 12 in one day', createdAt: '2026-07-25 10:15' },
    { id: '3', actorRole: 'support', action: 'order.view', entityType: 'Order',
      entityId: 'ord-1234', amountPesewas: null, reason: null, createdAt: '2026-07-25 09:58' },
  ];
}

export default async function Audit() {
  const rows = await getAudit();
  return (
    <>
      <h1>Audit log</h1>
      <p className="sub">Append-only. Entries can never be edited or deleted.</p>
      <table>
        <thead>
          <tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Amount</th><th>Reason</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.createdAt}</td>
              <td><span className="pill">{r.actorRole}</span></td>
              <td className="mono">{r.action}</td>
              <td className="mono">{r.entityType}/{r.entityId}</td>
              <td className="mono">{r.amountPesewas ? formatCedis(r.amountPesewas) : '—'}</td>
              <td style={{ color: r.reason ? 'inherit' : 'var(--muted)' }}>{r.reason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
