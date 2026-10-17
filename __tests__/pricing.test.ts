import { describe, expect, it } from "vitest";
import { FEE_PARAMS, PRICE_LIST_AMOUNTS, VAT_RATE, baseFee, priceTransaction } from "@/lib/pricing/engine";

/** The published price list: F_t = max(0.10, min(1.5% x A, 0.30 + 0.40 x ln(1 + A/100), 3.00)), VAT 15% of F_t, both to the nearest santim. */
const LIST: { amount: number; fee: number; vat: number; total: number }[] = [
  { amount: 5, fee: 0.1, vat: 0.02, total: 0.12 },
  { amount: 10, fee: 0.15, vat: 0.02, total: 0.17 },
  { amount: 25, fee: 0.38, vat: 0.06, total: 0.44 },
  { amount: 50, fee: 0.46, vat: 0.07, total: 0.53 },
  { amount: 100, fee: 0.58, vat: 0.09, total: 0.67 },
  { amount: 200, fee: 0.74, vat: 0.11, total: 0.85 },
  { amount: 500, fee: 1.02, vat: 0.15, total: 1.17 },
  { amount: 1_000, fee: 1.26, vat: 0.19, total: 1.45 },
  { amount: 2_500, fee: 1.6, vat: 0.24, total: 1.84 },
  { amount: 5_000, fee: 1.87, vat: 0.28, total: 2.15 },
  { amount: 10_000, fee: 2.15, vat: 0.32, total: 2.47 },
  { amount: 25_000, fee: 2.51, vat: 0.38, total: 2.89 },
  { amount: 50_000, fee: 2.79, vat: 0.42, total: 3.21 },
  { amount: 85_300, fee: 3.0, vat: 0.45, total: 3.45 },
];

describe("pricing engine: the published price list", () => {
  for (const c of LIST) {
    it(`${c.amount} ETB`, () => {
      const p = priceTransaction(c.amount);
      expect(p.amount).toBe(c.amount);
      expect(p.base_fee).toBe(c.fee);
      expect(p.vat_fee).toBe(c.vat);
      expect(p.total_fee).toBe(c.total);
      expect(p.net_merchant_settlement).toBe(Math.round((c.amount - c.total) * 100) / 100);
      expect(p.vat_rate).toBe(0.15);
    });
  }
});

describe("pricing engine: which part of the formula applies", () => {
  it("the 0.10 floor below about 6.7 ETB", () => {
    for (const a of [0.2, 1, 5, 6.5]) expect(priceTransaction(a)).toMatchObject({ band: "FLOOR", base_fee: 0.1 });
  });
  it("1.5% of the amount from about 6.7 to 26 ETB", () => {
    for (const a of [7, 10, 20, 25]) expect(priceTransaction(a).band).toBe("MICRO");
  });
  it("the smooth curve from about 26 ETB", () => {
    for (const a of [27, 50, 1_000, 85_000]) expect(priceTransaction(a).band).toBe("CURVE");
  });
  it("the 3.00 cap from about 85,300 ETB, however large", () => {
    for (const a of [86_000, 100_000, 1_000_000, 50_000_000]) expect(priceTransaction(a)).toMatchObject({ band: "CAP", base_fee: 3, vat_fee: 0.45, total_fee: 3.45 });
  });
  it("the constants are the ones in the schedule", () => {
    expect(FEE_PARAMS).toEqual({ floor: 0.1, base: 0.3, slope: 0.4, cap: 3, microPerMille: 15 });
  });
});

describe("pricing engine: rounding", () => {
  it("rounds the fee to the nearest santim, half up (25 ETB: 1.5% is exactly 0.375 -> 0.38)", () => {
    expect(baseFee(25)).toBe(0.38);
    expect(baseFee(10)).toBe(0.15);
  });
  it("rounds the VAT to the nearest santim on the rounded fee (0.10 x 15% = 0.015 -> 0.02; 0.58 x 15% = 0.087 -> 0.09)", () => {
    expect(priceTransaction(5).vat_fee).toBe(0.02);
    expect(priceTransaction(100).vat_fee).toBe(0.09);
    expect(priceTransaction(2_500).vat_fee).toBe(0.24);
  });
  it("fee, VAT and total are always whole santim", () => {
    for (let a = 1; a <= 3000; a += 7.31) {
      const p = priceTransaction(Math.round(a * 100) / 100);
      for (const v of [p.base_fee, p.vat_fee, p.total_fee]) expect(Math.abs(Math.round(v * 100) - v * 100)).toBeLessThan(1e-6);
    }
  });
});

describe("pricing engine: the ledger arithmetic always adds up", () => {
  const amounts = [0.6, 1, 9.99, 99.99, 100, 123.45, 250, 499.99, 500, 1234.56, 4999.99, 5000, 9999.99, 10000, 12345.67, 85300, 999999];
  it("total = fee + VAT, VAT = 15% of fee (to the santim), net = amount - total", () => {
    for (const a of amounts) {
      const p = priceTransaction(a);
      expect(Math.abs(p.total_fee - (p.base_fee + p.vat_fee))).toBeLessThan(1e-9);
      expect(Math.abs(p.vat_fee - p.base_fee * VAT_RATE)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(Math.abs(p.net_merchant_settlement - (a - p.total_fee))).toBeLessThan(1e-9);
    }
  });
  it("VAT is charged on the 2Pay fee only, never on the amount", () => {
    expect(priceTransaction(100_000).vat_fee).toBe(0.45);
    expect(priceTransaction(1_000_000).vat_fee).toBe(0.45);
  });
  it("never more than 4 decimals, so it stores exactly in numeric(14,4)", () => {
    for (const a of amounts) {
      const p = priceTransaction(a);
      for (const v of [p.base_fee, p.vat_fee, p.total_fee, p.net_merchant_settlement]) expect(Math.abs(Math.round(v * 10_000) - v * 10_000)).toBeLessThan(1e-6);
    }
  });
  it("the fee never goes down as the amount goes up, and never exceeds the cap or drops under the floor", () => {
    let last = 0;
    for (let a = 0.5; a < 120_000; a *= 1.013) {
      const f = baseFee(Math.round(a * 100) / 100);
      expect(f).toBeGreaterThanOrEqual(last);
      expect(f).toBeGreaterThanOrEqual(0.1);
      expect(f).toBeLessThanOrEqual(3);
      last = f;
    }
  });
  it("is smooth: no jump between neighbouring amounts (no tier steps)", () => {
    for (const a of [99, 100, 499, 500, 4_999, 5_000, 9_999, 10_000]) expect(Math.abs(baseFee(a + 1) - baseFee(a))).toBeLessThanOrEqual(0.01);
  });
  it("the fee is a small and falling share of the amount as it grows", () => {
    expect(priceTransaction(50).base_fee / 50).toBeLessThan(0.0093);
    expect(priceTransaction(1_000).base_fee / 1_000).toBeLessThan(0.00126 + 1e-5);
    expect(priceTransaction(50_000).base_fee / 50_000).toBeLessThan(0.0001);
  });
});

describe("pricing engine: the price list shown in the admin hub", () => {
  it("every listed amount can be priced and yields a positive net", () => {
    for (const a of PRICE_LIST_AMOUNTS) expect(priceTransaction(a).net_merchant_settlement).toBeGreaterThan(0);
  });
});

describe("pricing engine: bad input", () => {
  it("refuses zero, negative, NaN and infinite amounts", () => {
    for (const bad of [0, -5, NaN, Infinity, -Infinity]) expect(() => priceTransaction(bad)).toThrow(RangeError);
  });
  it("refuses a non-number", () => {
    // @ts-expect-error deliberately wrong type
    expect(() => priceTransaction("100")).toThrow(RangeError);
  });
  it("a payment smaller than its own fee has no positive net", () => {
    expect(priceTransaction(0.1).net_merchant_settlement).toBeLessThanOrEqual(0);
    expect(priceTransaction(0.12).net_merchant_settlement).toBeLessThanOrEqual(0);
  });
});
