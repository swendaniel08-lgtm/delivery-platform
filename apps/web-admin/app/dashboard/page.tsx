import { evaluateAlarms, type DashboardMetrics } from '../../../svc-admin/src/audit';
import { formatCedis } from '../../lib/format';

/** Live figures arrive from admin-bff; shape matches DashboardMetrics exactly. */
async function getMetrics(): Promise<DashboardMetrics> {
  return {
    ordersToday: 234,
    revenuePesewas: 1_240_000n,
    activeRiders: 47,
    activeVendors: 156,
    cancellationRatePct: 4.0,
    unremittedCodPesewas: 230_000n,
    openTasks: 3,
    ledgerHealthy: true,
  };
}

export default async function Dashboard() {
  const m = await getMetrics();
  const alarms = evaluateAlarms(m);

  return (
    <>
      <h1>Today&rsquo;s overview</h1>
      <p className="sub">Accra — Osu zone</p>

      {alarms.map((a) => (
        <div key={a.code} className={`alarm ${a.severity}`}>
          <strong>{a.severity === 'critical' ? 'Critical' : 'Warning'}:</strong> {a.message}
        </div>
      ))}

      <div className="cards">
        <Card k="Orders" v={String(m.ordersToday)} />
        <Card k="Revenue" v={formatCedis(m.revenuePesewas)} />
        <Card k="Active riders" v={String(m.activeRiders)} />
        <Card k="Vendors" v={String(m.activeVendors)} />
        <Card k="Cancellation rate" v={`${m.cancellationRatePct.toFixed(1)}%`} />
        <Card k="Unremitted COD" v={formatCedis(m.unremittedCodPesewas)} />
        <Card k="Open tasks" v={String(m.openTasks)} />
        <Card k="Ledger" v={m.ledgerHealthy ? 'Balanced' : 'DRIFT'} />
      </div>
    </>
  );
}

function Card({ k, v }: { k: string; v: string }) {
  return <div className="card"><div className="k">{k}</div><div className="v mono">{v}</div></div>;
}
