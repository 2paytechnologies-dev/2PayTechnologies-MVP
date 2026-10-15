/**
 * The 2Pay orchestration fee: a tiered schedule on the transaction amount (T_a, in ETB), with 15% VAT charged on 2Pay's fee only.
 *
 *   T_a < 100            base 0.50
 *   100 <= T_a < 500     base rises linearly from 0.86 (at 100) towards 0.989 (at 500):
 *                          0.86 + ((T_a - 100) / 400) * (0.989 - 0.86)
 *   500 <= T_a < 5,000   base 1.50
 *   5,000 <= T_a < 10,000 base 2.00
 *   T_a >= 10,000        base 5.00 (a hard ceiling, however large the payment)
 *
 *   vat_fee = base_fee * 15%      total_fee = base_fee + vat_fee      net_merchant_settlement = T_a - total_fee
 *
 * Money is held in ten-thousandths of an ETB (integers) so no floating-point drift can creep into the ledger; the figures
 * returned are those integers divided back to ETB (at most 4 decimals), which is also how they are stored.
 *
 * The schedule has two steps by design (it jumps at 100 and at 500). Those are the published brackets, not a bug.
 */

export const VAT_PERCENT = 15;
export const VAT_RATE = VAT_PERCENT / 100;
const UNIT = 10_000; // 1 ETB = 10,000 units

export interface Bracket {
  /** Inclusive lower bound of the bracket, in ETB. */
  from: number;
  /** Exclusive upper bound (Infinity for the top bracket). */
  to: number;
  label: string;
}

export const BRACKETS: Bracket[] = [
  { from: 0, to: 100, label: "Under 100 ETB" },
  { from: 100, to: 500, label: "100 to under 500 ETB" },
  { from: 500, to: 5_000, label: "500 to under 5,000 ETB" },
  { from: 5_000, to: 10_000, label: "5,000 to under 10,000 ETB" },
  { from: 10_000, to: Infinity, label: "10,000 ETB and over" },
];

export interface Price {
  amount: number;
  /** 2Pay's fee before VAT. */
  base_fee: number;
  vat_rate: number;
  /** 15% of base_fee. */
  vat_fee: number;
  /** base_fee + vat_fee: what is deducted from the merchant. */
  total_fee: number;
  /** amount - total_fee: what the merchant receives. */
  net_merchant_settlement: number;
  bracket: string;
}

const toUnits = (etb: number) => Math.round(etb * UNIT);
const toEtb = (units: number) => units / UNIT;

/** The base fee in ETB units for an amount in ETB units. */
function baseUnits(amountUnits: number): number {
  const a = amountUnits / UNIT;
  if (a < 100) return toUnits(0.5);
  if (a < 500) return Math.round(toUnits(0.86) + ((amountUnits - toUnits(100)) / toUnits(400)) * (toUnits(0.989) - toUnits(0.86)));
  if (a < 5_000) return toUnits(1.5);
  if (a < 10_000) return toUnits(2);
  return toUnits(5);
}

/** The fee schedule for one transaction amount (ETB, greater than zero). Throws on anything that is not a positive finite amount. */
export function priceTransaction(amount: number): Price {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) throw new RangeError("amount must be a positive number");
  const a = toUnits(amount);
  const base = baseUnits(a);
  const vat = Math.round((base * VAT_PERCENT) / 100); // integer arithmetic: 9890 * 15 / 100 is exactly 1483.5, never 1483.4999...
  const total = base + vat;
  const bracket = BRACKETS.find((b) => amount >= b.from && amount < b.to) ?? BRACKETS[BRACKETS.length - 1];
  return { amount: toEtb(a), base_fee: toEtb(base), vat_rate: VAT_RATE, vat_fee: toEtb(vat), total_fee: toEtb(total), net_merchant_settlement: toEtb(a - total), bracket: bracket.label };
}

/** The base fee alone, for display and tests. */
export const baseFee = (amount: number) => priceTransaction(amount).base_fee;
