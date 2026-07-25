/**
 * libs/money — the ONLY place money arithmetic is allowed.
 *
 * Rule (MASTER_PLAN §1.2.5): money is integer pesewas, held as bigint.
 * 1 GHS = 100 pesewas. Floats are never used in a money code path.
 *
 * Closes issue #5 (spec used DECIMAL, which drifts across 15 services).
 */

export type Pesewas = bigint;

export class MoneyError extends Error {}

const PESEWAS_PER_CEDI = 100n;

/** Parse a human GHS string ("35", "35.5", "35.50", "-2.05") into pesewas. */
export function fromCedis(input: string | number): Pesewas {
  const s = typeof input === 'number' ? numToStr(input) : input.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) {
    throw new MoneyError(`invalid GHS amount: ${JSON.stringify(input)}`);
  }
  const neg = s.startsWith('-');
  const [whole, frac = ''] = (neg ? s.slice(1) : s).split('.') as [string, string?];
  const pesewas = BigInt(whole) * PESEWAS_PER_CEDI + BigInt(frac.padEnd(2, '0'));
  return neg ? -pesewas : pesewas;
}

/** Reject float inputs that cannot be exact pesewas (e.g. 0.1 + 0.2). */
function numToStr(n: number): string {
  if (!Number.isFinite(n)) throw new MoneyError(`non-finite amount: ${n}`);
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-9) {
    throw new MoneyError(`amount has sub-pesewa precision: ${n}`);
  }
  return (Math.round(n * 100) / 100).toFixed(2);
}

export const pesewas = (n: number | bigint): Pesewas => {
  const v = typeof n === 'number' ? n : Number(n);
  if (typeof n === 'number' && !Number.isInteger(v)) {
    throw new MoneyError(`pesewas must be a whole number: ${n}`);
  }
  return BigInt(n);
};

/** Format for display only. Never feed this back into arithmetic. */
export function toCedis(p: Pesewas): string {
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const whole = abs / PESEWAS_PER_CEDI;
  const frac = abs % PESEWAS_PER_CEDI;
  return `${neg ? '-' : ''}${whole}.${frac.toString().padStart(2, '0')}`;
}

/**
 * Display formatting WITH thousand separators.
 *
 * `toCedis` stays separator-free because it must round-trip through
 * `fromCedis`. This is the one function UI layers should call, so the
 * backend and the admin dashboard can never disagree about how money looks.
 */
export function formatCedis(p: Pesewas): string {
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const whole = (abs / PESEWAS_PER_CEDI).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (abs % PESEWAS_PER_CEDI).toString().padStart(2, '0');
  // Sign goes with the NUMBER, not before the currency: "GHS -2.05".
  // A refund line reading "-GHS 2.05" reads as a negative currency.
  return `GHS ${neg ? '-' : ''}${whole}.${frac}`;
}

/** @deprecated use formatCedis — kept so existing call sites keep compiling. */
export const format = (p: Pesewas): string => formatCedis(p);

export const add = (...xs: Pesewas[]): Pesewas => xs.reduce((a, b) => a + b, 0n);
export const sub = (a: Pesewas, b: Pesewas): Pesewas => a - b;
export const neg = (a: Pesewas): Pesewas => -a;
export const abs = (a: Pesewas): Pesewas => (a < 0n ? -a : a);
export const isZero = (a: Pesewas): boolean => a === 0n;
export const min = (a: Pesewas, b: Pesewas): Pesewas => (a < b ? a : b);
export const max = (a: Pesewas, b: Pesewas): Pesewas => (a > b ? a : b);

export function mul(a: Pesewas, qty: number): Pesewas {
  if (!Number.isInteger(qty) || qty < 0) {
    throw new MoneyError(`quantity must be a non-negative integer: ${qty}`);
  }
  return a * BigInt(qty);
}

export type Rounding = 'half-up' | 'floor' | 'ceil';

/**
 * Percentage in BASIS POINTS (1500 = 15%). Integer bps only — no float rates.
 * Used for commission (food 15% = 1500) and service fees.
 */
export function bps(amount: Pesewas, basisPoints: number, rounding: Rounding = 'half-up'): Pesewas {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new MoneyError(`basis points must be a non-negative integer: ${basisPoints}`);
  }
  const numerator = amount * BigInt(basisPoints);
  return divRound(numerator, 10_000n, rounding);
}

function divRound(numerator: bigint, denominator: bigint, mode: Rounding): bigint {
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  const q = n / denominator;
  const r = n % denominator;
  let out: bigint;
  if (r === 0n) out = q;
  else if (mode === 'floor') out = negative ? q + 1n : q;
  else if (mode === 'ceil') out = negative ? q : q + 1n;
  else out = r * 2n >= denominator ? q + 1n : q; // half-up on magnitude
  return negative ? -out : out;
}

/** Clamp to an inclusive range — e.g. food service fee: min GHS 2, max GHS 15. */
export function clamp(value: Pesewas, lo: Pesewas, hi: Pesewas): Pesewas {
  if (lo > hi) throw new MoneyError('clamp: lo > hi');
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Split an amount into `parts` shares with NO cent leakage.
 * Remainder pesewas are distributed one each to the earliest parts.
 * sum(allocate(x, n)) === x, always.
 */
export function allocate(amount: Pesewas, parts: number): Pesewas[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new MoneyError(`parts must be a positive integer: ${parts}`);
  }
  const n = BigInt(parts);
  const base = amount / n;
  let remainder = amount - base * n;
  const step = remainder < 0n ? -1n : 1n;
  const out: Pesewas[] = [];
  for (let i = 0; i < parts; i++) {
    if (remainder !== 0n) {
      out.push(base + step);
      remainder -= step;
    } else out.push(base);
  }
  return out;
}

/**
 * Split by integer weights (e.g. vendor/rider/platform) with no leakage.
 * Largest-remainder method. sum(result) === amount, always.
 */
export function allocateByWeights(amount: Pesewas, weights: number[]): Pesewas[] {
  if (weights.length === 0) throw new MoneyError('weights must not be empty');
  if (weights.some((w) => !Number.isInteger(w) || w < 0)) {
    throw new MoneyError('weights must be non-negative integers');
  }
  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0) throw new MoneyError('weights must not sum to zero');

  const totalB = BigInt(total);
  const shares = weights.map((w) => (amount * BigInt(w)) / totalB);
  let distributed = shares.reduce((a, b) => a + b, 0n);
  let remainder = amount - distributed;

  const order = weights
    .map((w, i) => ({ i, rem: (amount * BigInt(w)) % totalB }))
    .sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.i - b.i));

  const step = remainder < 0n ? -1n : 1n;
  let k = 0;
  while (remainder !== 0n) {
    const target = order[k % order.length]!;
    shares[target.i] = shares[target.i]! + step;
    remainder -= step;
    k++;
  }
  return shares;
}
