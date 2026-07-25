/**
 * Display formatting.
 *
 * Money formatting is re-exported from libs/money so the dashboard and the
 * API can never disagree about how an amount looks. Do not reimplement it here.
 */
import { formatCedis as fmt } from '../../../libs/money/src/money';

/** Accepts the pesewa strings that come back over the wire. */
export function formatCedis(pesewas: string | bigint): string {
  return fmt(typeof pesewas === 'string' ? BigInt(pesewas) : pesewas);
}

export function formatState(state: string): string {
  return state.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
