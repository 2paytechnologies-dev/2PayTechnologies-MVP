import { describe, expect, it } from "vitest";
import { CATEGORY_LABEL, MCC_BY_CATEGORY, REGISTRATION_CATEGORIES, adTargetFor, isRegistrationCategory, kindFor } from "@/lib/categories";
import { hashLinkCode, newLinkCode, normalizeLinkCode, parseRideIntent } from "@/lib/ride";
import { DEFAULT_TAX_RULES, estimateTax, resolveRules, taxEligibility, validateRules, type MonthVolume } from "@/lib/tax";

describe("registration categories", () => {
  it("offers exactly the five categories, in order", () => {
    expect([...REGISTRATION_CATEGORIES]).toEqual(["Fuel", "Supermarket", "Service", "Ride", "Merchant"]);
  });
  it("accepts those and refuses anything else, including the legacy Retail", () => {
    for (const c of REGISTRATION_CATEGORIES) expect(isRegistrationCategory(c)).toBe(true);
    for (const c of ["Retail", "fuel", "", null, undefined, 5, "Restaurant"]) expect(isRegistrationCategory(c)).toBe(false);
  });
  it("makes a Ride registration an individual driver and every other a business", () => {
    expect(kindFor("Ride")).toBe("DRIVER");
    for (const c of ["Fuel", "Supermarket", "Service", "Merchant", "Retail"] as const) expect(kindFor(c)).toBe("MERCHANT");
  });
  it("has a label, a merchant category code and an ad target for each", () => {
    for (const c of [...REGISTRATION_CATEGORIES, "Retail"] as const) {
      expect(CATEGORY_LABEL[c]).toBeTruthy();
      expect(MCC_BY_CATEGORY[c]).toMatch(/^\d{4}$/);
    }
    expect(adTargetFor("Fuel")).toBe("Fuel");
    expect(adTargetFor("Ride")).toBe("Retail");
  });
});

describe("driver link codes", () => {
  it("makes readable one-time codes that normalise and hash the same way", () => {
    const { code, hash } = newLinkCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(code).not.toMatch(/[01OI]/);
    expect(normalizeLinkCode(code)).toBe(code.replace("-", ""));
    expect(normalizeLinkCode(code.toLowerCase().replace("-", " "))).toBe(code.replace("-", ""));
    expect(hashLinkCode(normalizeLinkCode(code)!)).toBe(hash);
  });
  it("refuses codes of the wrong shape", () => {
    for (const bad of ["", "ABC", "ABCD-EFG", "ABCD-EFGHJ", null, 5, "ABCD-EF!H"]) expect(normalizeLinkCode(bad)).toBeNull();
  });
  it("does not repeat", () => {
    expect(new Set(Array.from({ length: 200 }, () => newLinkCode().code)).size).toBe(200);
  });
});

describe("ride intents without partner-sent accounts", () => {
  const base = { partner_ride_id: "ride-1", driver_id: "drv_1", fare_amount: 120, currency: "ETB" };
  it("takes a ride with no accounts (the driver's own are used)", () => {
    const r = parseRideIntent(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.accounts).toBeNull();
  });
  it("still checks accounts when they are sent", () => {
    expect(parseRideIntent({ ...base, driver_wallet_accounts: [{ rail: "NOPE", account_number: "1" }] }).ok).toBe(false);
  });
});

describe("tax rules", () => {
  it("defaults are filled in for empty or junk input", () => {
    expect(resolveRules({})).toEqual(DEFAULT_TAX_RULES);
    expect(resolveRules(null)).toEqual(DEFAULT_TAX_RULES);
    expect(resolveRules({ vat: { rate: "lots", threshold: -5 } }).vat).toEqual(DEFAULT_TAX_RULES.vat);
  });
  it("keeps valid stored values", () => {
    const r = resolveRules({ vat: { rate: 0.2, threshold: 500000, inclusive: false }, turnover: { rate: 0.03, byCategory: { Service: 0.12 } } });
    expect(r.vat).toEqual({ rate: 0.2, threshold: 500000, inclusive: false });
    expect(r.turnover.byCategory.Service).toBe(0.12);
    expect(r.turnover.byCategory.Fuel).toBe(0.02);
  });
  it("refuses bad rules from an administrator instead of fixing them quietly", () => {
    const ok = { vat: { rate: 0.15, threshold: 1000000, inclusive: true }, turnover: { rate: 0.02 } };
    expect(validateRules(ok).ok).toBe(true);
    expect(validateRules({ ...ok, vat: { ...ok.vat, rate: 15 } }).ok).toBe(false); // 15, not 0.15
    expect(validateRules({ ...ok, vat: { ...ok.vat, threshold: -1 } }).ok).toBe(false);
    expect(validateRules({ ...ok, vat: { ...ok.vat, inclusive: "yes" } }).ok).toBe(false);
    expect(validateRules({ ...ok, turnover: { rate: 0.02, byCategory: { Spaceship: 0.1 } } }).ok).toBe(false);
    expect(validateRules(null).ok).toBe(false);
  });
});

describe("tax estimate", () => {
  const rules = resolveRules({});
  const now = new Date("2026-06-15T09:00:00Z"); // June in Addis Ababa
  const month = (m: string, gross: number, refunded = 0, tips = 0, sales = 1): MonthVolume => ({ month: m, sales, gross, tips, refunded });

  it("uses turnover tax below the VAT threshold, by category", () => {
    const vol = [month("2026-01", 10000), month("2026-02", 20000)];
    const shop = estimateTax(vol, 2026, "Supermarket", rules, now);
    expect(shop.regime).toBe("TURNOVER");
    expect(shop.rate).toBe(0.02);
    expect(shop.ytd).toEqual({ turnover: 30000, tax: 600 });
    expect(estimateTax(vol, 2026, "Service", rules, now).ytd.tax).toBe(3000); // services at 10%
  });
  it("projects the year over the months that have passed (six by mid-June)", () => {
    const e = estimateTax([month("2026-01", 60000)], 2026, "Merchant", rules, now);
    expect(e.monthsCounted).toBe(6);
    expect(e.projected.turnover).toBe(120000);
  });
  it("switches to VAT once the projection reaches the threshold, taking VAT out of a VAT-inclusive price", () => {
    const e = estimateTax([month("2026-01", 600000), month("2026-02", 600000)], 2026, "Merchant", rules, now);
    expect(e.regime).toBe("VAT");
    expect(e.ytd.turnover).toBe(1200000);
    expect(e.ytd.tax).toBe(156521.74); // 1,200,000 x 0.15 / 1.15
    const exclusive = estimateTax([month("2026-01", 600000), month("2026-02", 600000)], 2026, "Merchant", resolveRules({ vat: { rate: 0.15, threshold: 1000000, inclusive: false } }), now);
    expect(exclusive.ytd.tax).toBe(180000);
  });
  it("takes refunds off, never counts tips, and never goes below zero", () => {
    const e = estimateTax([month("2026-03", 10000, 2500, 900), month("2026-04", 100, 500)], 2026, "Fuel", rules, now);
    expect(e.months.map((m) => m.turnover)).toEqual([7500, 0]);
    expect(e.ytd.turnover).toBe(7500);
  });
  it("ignores other years and treats a finished year as twelve months", () => {
    const e = estimateTax([month("2025-12", 999999), month("2026-01", 1200)], 2025, "Merchant", rules, now);
    expect(e.monthsCounted).toBe(12);
    expect(e.months).toHaveLength(1);
    expect(e.projected.turnover).toBe(999999);
  });
  it("is all zero with no payments", () => {
    const e = estimateTax([], 2026, "Merchant", rules, now);
    expect(e.ytd).toEqual({ turnover: 0, tax: 0 });
    expect(e.projected).toEqual({ turnover: 0, tax: 0 });
  });
});

describe("tax eligibility", () => {
  it("needs both a TIN and a business licence", () => {
    expect(taxEligibility({ tin: "0012345678", business_license: "AA/1/2020" })).toEqual({ eligible: true, missing: [] });
    expect(taxEligibility({ tin: null, business_license: "x" })).toEqual({ eligible: false, missing: ["tin"] });
    expect(taxEligibility({ tin: "", business_license: undefined })).toEqual({ eligible: false, missing: ["tin", "business_license"] });
  });
});
