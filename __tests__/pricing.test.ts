import { describe, expect, it } from "vitest";
import { BRACKETS, VAT_RATE, baseFee, priceTransaction } from "@/lib/pricing/engine";

/** The published schedule: boundary and in-between amounts, written out so any change to the fees is a deliberate one. */
const CASES: { amount: number; base: number; vat: number; total: number; net: number; bracket: string }[] = [
  { amount: 99.99, base: 0.5, vat: 0.075, total: 0.575, net: 99.415, bracket: "Under 100 ETB" },
  { amount: 100, base: 0.86, vat: 0.129, total: 0.989, net: 99.011, bracket: "100 to under 500 ETB" },
  { amount: 300, base: 0.9245, vat: 0.1387, total: 1.0632, net: 298.9368, bracket: "100 to under 500 ETB" },
  { amount: 499.99, base: 0.989, vat: 0.1484, total: 1.1374, net: 498.8526, bracket: "100 to under 500 ETB" },
  { amount: 500, base: 1.5, vat: 0.225, total: 1.725, net: 498.275, bracket: "500 to under 5,000 ETB" },
  { amount: 4999, base: 1.5, vat: 0.225, total: 1.725, net: 4997.275, bracket: "500 to under 5,000 ETB" },
  { amount: 5000, base: 2, vat: 0.3, total: 2.3, net: 4997.7, bracket: "5,000 to under 10,000 ETB" },
  { amount: 9999, base: 2, vat: 0.3, total: 2.3, net: 9996.7, bracket: "5,000 to under 10,000 ETB" },
  { amount: 10000, base: 5, vat: 0.75, total: 5.75, net: 9994.25, bracket: "10,000 ETB and over" },
  { amount: 50000, base: 5, vat: 0.75, total: 5.75, net: 49994.25, bracket: "10,000 ETB and over" },
];

describe("pricing engine: boundary amounts", () => {
  for (const c of CASES) {
    it(`${c.amount} ETB`, () => {
      const p = priceTransaction(c.amount);
      expect(p.amount).toBe(c.amount);
      expect(p.base_fee).toBe(c.base);
      expect(p.vat_fee).toBe(c.vat);
      expect(p.total_fee).toBe(c.total);
      expect(p.net_merchant_settlement).toBe(c.net);
      expect(p.bracket).toBe(c.bracket);
      expect(p.vat_rate).toBe(0.15);
    });
  }
});

describe("pricing engine: the published figures", () => {
  it("under 100 ETB costs 0.575 ETB in total (0.50 + 15% VAT)", () => expect(priceTransaction(40).total_fee).toBe(0.575));
  it("500 to 5,000 ETB costs 1.725 ETB", () => expect(priceTransaction(2500).total_fee).toBe(1.725));
  it("5,000 to 10,000 ETB costs 2.300 ETB", () => expect(priceTransaction(7500).total_fee).toBe(2.3));
  it("10,000 ETB and over is capped at 5.750 ETB, however large", () => {
    for (const a of [10_000, 25_000, 1_000_000]) expect(priceTransaction(a).total_fee).toBe(5.75);
  });
  it("the linear bracket follows 0.86 + ((T - 100) / 400) * 0.129", () => {
    for (const a of [100, 150, 250, 300, 400, 499]) {
      const want = 0.86 + ((a - 100) / 400) * (0.989 - 0.86);
      expect(Math.abs(baseFee(a) - want)).toBeLessThan(0.00006); // within half a ten-thousandth
    }
  });
});

describe("pricing engine: the ledger arithmetic always adds up", () => {
  const amounts = [0.6, 1, 9.99, 99.99, 100, 123.45, 250, 499.99, 500, 1234.56, 4999.99, 5000, 9999.99, 10000, 12345.67, 999999];
  it("total = base + VAT, VAT = 15% of base, net = amount - total", () => {
    for (const a of amounts) {
      const p = priceTransaction(a);
      expect(Math.abs(p.total_fee - (p.base_fee + p.vat_fee))).toBeLessThan(1e-9);
      expect(Math.abs(p.vat_fee - p.base_fee * VAT_RATE)).toBeLessThanOrEqual(0.00005 + 1e-9);
      expect(Math.abs(p.net_merchant_settlement - (a - p.total_fee))).toBeLessThan(1e-9);
    }
  });
  it("VAT is charged on the 2Pay fee only, never on the amount", () => {
    expect(priceTransaction(10_000).vat_fee).toBe(0.75);
    expect(priceTransaction(1_000_000).vat_fee).toBe(0.75);
  });
  it("never more than 4 decimals, so it stores exactly in numeric(14,4)", () => {
    for (const a of amounts) {
      const p = priceTransaction(a);
      for (const v of [p.base_fee, p.vat_fee, p.total_fee, p.net_merchant_settlement]) expect(Math.abs(Math.round(v * 10_000) - v * 10_000)).toBeLessThan(1e-6);
    }
  });
  it("the fee never goes down as the amount goes up within a bracket, and never exceeds the cap", () => {
    let last = 0;
    for (let a = 100; a < 500; a += 0.5) {
      const f = baseFee(a);
      expect(f).toBeGreaterThanOrEqual(last);
      last = f;
    }
    for (const a of amounts) expect(priceTransaction(a).total_fee).toBeLessThanOrEqual(5.75);
  });
  it("each bracket boundary falls in the bracket that starts there", () => {
    for (const b of BRACKETS.slice(1)) expect(priceTransaction(b.from).bracket).toBe(b.label);
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
});
