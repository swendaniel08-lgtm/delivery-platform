import { formatCedis, formatState } from '../../lib/format';

interface OrderRow {
  humanRef: string; service: string; state: string;
  totalPesewas: string; vendor: string; zone: string;
}

async function getOrders(): Promise<OrderRow[]> {
  return [
    { humanRef: '#1234', service: 'food', state: 'in_transit', totalPesewas: '8150', vendor: "Auntie Adwoa's", zone: 'Osu' },
    { humanRef: '#1235', service: 'parcel', state: 'rider_assigned', totalPesewas: '2500', vendor: '—', zone: 'Tema' },
    { humanRef: '#1236', service: 'errand', state: 'task_in_progress', totalPesewas: '13250', vendor: '—', zone: 'Legon' },
    { humanRef: '#1237', service: 'laundry', state: 'processing', totalPesewas: '9600', vendor: 'Clean Co', zone: 'Osu' },
  ];
}

export default async function Orders() {
  const orders = await getOrders();
  return (
    <>
      <h1>Orders</h1>
      <p className="sub">{orders.length} active</p>
      <table>
        <thead>
          <tr><th>Ref</th><th>Service</th><th>Status</th><th>Vendor</th><th>Zone</th><th>Total</th></tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.humanRef}>
              <td className="mono">{o.humanRef}</td>
              <td><span className="pill">{o.service}</span></td>
              <td>{formatState(o.state)}</td>
              <td>{o.vendor}</td>
              <td>{o.zone}</td>
              <td className="mono">{formatCedis(o.totalPesewas)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
