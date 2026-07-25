/** Display formatting. Money arrives as pesewa strings and stays exact. */
export function formatCedis(pesewas: string | bigint): string {
  const v = typeof pesewas === 'string' ? BigInt(pesewas) : pesewas;
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}GHS ${whole}.${frac}`;
}

export function formatState(state: string): string {
  return state.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
