/**
 * The 2Pay orchestration fee F_t on a transaction amount A (ETB), with 15% VAT charged on 2Pay's fee only.
 *
 *   F_t = max(0.10, min(1.5% x A, 0.30 + 0.40 x ln(1 + A/100), 3.00)), rounded to the nearest santim
 *
 *   band     active range (ETB)     what it is
 *   FLOOR    A below about 6.7      the 0.10 minimum fee
 *   MICRO    about 6.7 to 26        1.5% of the amount (keeps tiny payments cheap)
 *   CURVE    about 26 to 85,300     0.30 + 0.40 x ln(1 + A/100): smooth, no tier jumps
 *   CAP      about 85,300 and over  the 3.00 maximum fee
 *
 *   vat_fee = F_t x 15%, rounded to the nearest santim      total_fee = F_t + vat_fee      net_merchant_settlement = A - total_fee
 *
 * The fee and the VAT are worked out in whole santim (hundredths of a birr) so the VAT rounding is exact. Amounts are held in
 * ten-thousandths of an ETB (integers) so no floating-point drift can creep into the ledger; the figures returned are those
 * integers divided back to ETB, which is also how they are stored (numeric(14,4)).
 *
 * Once the payment switch confirms its per-transaction cost, FEE_PARAMS.floor, .base and .slope are the three constants to change.
 */

export const VAT_PERCENT = 15;
export const VAT_RATE = VAT_PERCENT / 100;

/** The schedule's constants, in ETB (the micro-ticket guard is 1.5% = 15 per thousand). */
export const FEE_PARAMS = { floor: 0.1, base: 0.3, slope: 0.4, cap: 3.0, microPerMille: 15 } as const;

const UNIT = 10_000; // 1 ETB = 10,000 units
const SANTIM_UNITS = 100; // 1 santim = 100 units

export type Band = "FLOOR" | "MICRO" | "CURVE" | "CAP";

export const BAND_LABEL: Record<Band, string> = {
  FLOOR: "Minimum fee",
  MICRO: "1.5% of the amount",
  CURVE: "Smooth curve",
  CAP: "Maximum fee",
};

export interface Price {
  amount: number;
  /** 2Pay's fee before VAT (F_t). */
  base_fee: number;
  vat_rate: number;
  /** 15% of base_fee. */
  vat_fee: number;
  /** base_fee + vat_fee: what is deducted from the merchant. */
  total_fee: number;
  /** amount - total_fee: what the merchant receives. */
  net_merchant_settlement: number;
  /** Which part of the formula set the fee. */
  band: Band;
}

const toUnits = (etb: number) => Math.round(etb * UNIT);
const toEtb = (units: number) => units / UNIT;

/** F_t in whole santim, and which part of the formula set it, for an amount in ETB units. */
function feeSantim(amountUnits: number): { santim: number; band: Band } {
  const floor = FEE_PARAMS.floor * 100;
  const cap = FEE_PARAMS.cap * 100;
  // 1.5% of the amount, in santim, from the integer amount (so an exact half-santim is exactly a half).
  const micro = (amountUnits * FEE_PARAMS.microPerMille) / (1000 * SANTIM_UNITS);
  const curve = 100 * (FEE_PARAMS.base + FEE_PARAMS.slope * Math.log(1 + amountUnits / (100 * UNIT)));
  const raw = Math.max(floor, Math.min(micro, curve, cap));
  const band: Band = raw === floor ? "FLOOR" : raw === micro ? "MICRO" : raw === cap ? "CAP" : "CURVE";
  return { santim: Math.round(raw), band };
}

/** The fee schedule for one transaction amount (ETB, greater than zero). Throws on anything that is not a positive finite amount. */
export function priceTransaction(amount: number): Price {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) throw new RangeError("amount must be a positive number");
  const a = toUnits(amount);
  const { santim: fee, band } = feeSantim(a);
  const vat = Math.round((fee * VAT_PERCENT) / 100); // whole santim: 15 x 15 / 100 is exactly 2.25, 10 x 15 / 100 exactly 1.5 (rounds to 2)
  const base = fee * SANTIM_UNITS;
  const vatUnits = vat * SANTIM_UNITS;
  const total = base + vatUnits;
  return { amount: toEtb(a), base_fee: toEtb(base), vat_rate: VAT_RATE, vat_fee: toEtb(vatUnits), total_fee: toEtb(total), net_merchant_settlement: toEtb(a - total), band };
}

/** The base fee alone, for display and tests. */
export const baseFee = (amount: number) => priceTransaction(amount).base_fee;

/** Amounts shown in the published price list (the admin hub's fee panel and the docs). */
export const PRICE_LIST_AMOUNTS = [5, 10, 25, 50, 100, 200, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 85_300, 100_000];
