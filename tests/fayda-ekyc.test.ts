import { describe, expect, it } from "vitest";
import { EKYC_MAX_ATTEMPTS, SANDBOX_OTP, ekycGateway, ekycMode, fanHash, faydaRequired, normalizeFan } from "@/lib/fayda-ekyc";
import { createPayNode } from "@/lib/pay-nodes";
import { sealAccounts } from "@/lib/fieldcrypt";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("Fayda FAN", () => {
  it("is exactly 16 digits (spaces and dashes tolerated)", () => {
    expect(normalizeFan("1234 5678 9012 3456")).toBe("1234567890123456");
    expect(normalizeFan("1234-5678-9012-3456")).toBe("1234567890123456");
    for (const bad of ["123", "12345678901234567", "abcd567890123456", "", null, 1234567890123456]) expect(normalizeFan(bad)).toBeNull();
  });
  it("hashes with a key, so the same FAN matches and a different secret does not", () => {
    expect(fanHash("1234567890123456", "s".repeat(40))).toBe(fanHash("1234567890123456", "s".repeat(40)));
    expect(fanHash("1234567890123456", "s".repeat(40))).not.toBe(fanHash("1234567890123456", "t".repeat(40)));
    expect(fanHash("1234567890123456", "s".repeat(40))).not.toContain("1234567890123456");
  });
});

describe("e-KYC gateway selection", () => {
  it("sandbox only when asked, and NEVER with real money", () => {
    expect(ekycMode({ FAYDA_SANDBOX_MODE: "true" }, false)).toBe("sandbox");
    expect(ekycMode({ FAYDA_SANDBOX_MODE: "true" }, true)).toBeNull();
    expect(ekycMode({ FAYDA_SANDBOX_MODE: "true", RAIL_MODE: "live" })).toBeNull();
    expect(ekycMode({}, false)).toBeNull();
    expect(ekycMode({ FAYDA_SANDBOX_MODE: "false" }, false)).toBeNull();
  });
  it("uses the real gateway when its address and key are set", () => {
    expect(ekycMode({ FAYDA_EKYC_URL: "https://x", FAYDA_EKYC_KEY: "k" }, true)).toBe("gateway");
    expect(ekycMode({ FAYDA_EKYC_URL: "https://x" }, true)).toBeNull();
  });
  it("the sandbox accepts only the published test code", async () => {
    const g = ekycGateway({ FAYDA_SANDBOX_MODE: "true" }, false)!;
    const s = await g.initiate("1234567890123456");
    expect(s.ref).toMatch(/^sandbox-/);
    expect(SANDBOX_OTP).toBe("123456");
    expect((await g.verify("1234567890123456", s.ref, "123456")).ok).toBe(true);
    expect((await g.verify("1234567890123456", s.ref, "654321")).ok).toBe(false);
    expect(EKYC_MAX_ATTEMPTS).toBe(5);
  });
  it("there is no gateway when nothing is configured", () => expect(ekycGateway({}, false)).toBeNull());
});

describe("Fayda is mandatory with real money", () => {
  it("required in live mode by default, off in simulated mode, relaxed only by an explicit false", () => {
    expect(faydaRequired({}, true)).toBe(true);
    expect(faydaRequired({ KYC_REQUIRE_FAYDA: "true" }, true)).toBe(true);
    expect(faydaRequired({ KYC_REQUIRE_FAYDA: "false" }, true)).toBe(false);
    expect(faydaRequired({}, false)).toBe(false);
    expect(faydaRequired({ RAIL_MODE: "live" })).toBe(true);
  });
});

/** A tiny stand-in for the database client: one merchant, and an insert that echoes the row. */
function fakeAdmin(merchant: Record<string, unknown> | null) {
  const inserted: Record<string, unknown>[] = [];
  const admin = {
    from(table: string) {
      if (table === "merchants") {
        const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: merchant, error: null }) };
        return q;
      }
      return {
        insert(row: Record<string, unknown>) {
          inserted.push(row);
          const q = { select: () => q, single: async () => ({ data: { id: "tx-1", token: "tok", ...row }, error: null }) };
          return q;
        },
      };
    },
  };
  return { admin: admin as unknown as SupabaseClient, inserted };
}
const M = { id: "m1", active_bank: { id: "b1", institution: "Awash Bank", account_number: "01320123456789" }, active_wallet: null, kyc_status: "VERIFIED", static_qr_enabled: true, fayda_verified_at: null, fayda_verified: false };

describe("createPayNode records the fee ledger", () => {
  it("stores base fee, VAT and net settlement, with the total in fee_ft", async () => {
    const { admin, inserted } = fakeAdmin(M);
    const r = await createPayNode(admin, "m1", 300, "TERMINAL");
    expect(r.ok).toBe(true);
    expect(inserted[0]).toMatchObject({ amount: 300, base_fee: 0.85, vat_fee: 0.13, fee_ft: 0.98, net_merchant_settlement: 299.02 });
  });
  it("prices each amount from the schedule", async () => {
    for (const [amount, total, net] of [[50, 0.53, 49.47], [1000, 1.45, 998.55], [7000, 2.31, 6997.69], [20000, 2.78, 19997.22], [100000, 3.45, 99996.55]] as const) {
      const { admin, inserted } = fakeAdmin(M);
      expect((await createPayNode(admin, "m1", amount, "TERMINAL")).ok).toBe(true);
      expect(inserted[0]).toMatchObject({ fee_ft: total, net_merchant_settlement: net });
    }
  });
  it("refuses an amount too small to cover its own fee", async () => {
    const { admin, inserted } = fakeAdmin(M);
    const r = await createPayNode(admin, "m1", 0.1, "TERMINAL");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.body.code).toBe("AMOUNT_TOO_SMALL");
    expect(inserted).toHaveLength(0);
  });
  it("the Fayda gate blocks live payments for an unverified owner, and lets a verified one through", async () => {
    const live = { RAIL_MODE: process.env.RAIL_MODE, KYC: process.env.KYC_REQUIRE_FAYDA };
    process.env.RAIL_MODE = "live";
    delete process.env.KYC_REQUIRE_FAYDA;
    try {
      const blocked = await createPayNode(fakeAdmin(M).admin, "m1", 100, "TERMINAL");
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.body.code).toBe("FAYDA_REQUIRED");
      expect((await createPayNode(fakeAdmin({ ...M, fayda_verified: true }).admin, "m1", 100, "TERMINAL")).ok).toBe(true);
      expect((await createPayNode(fakeAdmin({ ...M, fayda_verified_at: "2026-01-01T00:00:00Z" }).admin, "m1", 100, "TERMINAL")).ok).toBe(true);
      process.env.KYC_REQUIRE_FAYDA = "false";
      expect((await createPayNode(fakeAdmin(M).admin, "m1", 100, "TERMINAL")).ok).toBe(true);
    } finally {
      if (live.RAIL_MODE === undefined) delete process.env.RAIL_MODE;
      else process.env.RAIL_MODE = live.RAIL_MODE;
      if (live.KYC === undefined) delete process.env.KYC_REQUIRE_FAYDA;
      else process.env.KYC_REQUIRE_FAYDA = live.KYC;
    }
  });
});

describe("a ride sale pays the driver, not the partner", () => {
  const driver = sealAccounts([
    { id: "d1", institution: "Telebirr", account_number: "+251911223344" },
    { id: "d2", institution: "CBE Birr", account_number: "+251922334455" },
    { id: "d3", institution: "Awash Bank", account_number: "01320123456789" },
  ]);
  it("stores the driver's accounts on the sale, shows only masked ones, and never returns the stored list", async () => {
    const { admin, inserted } = fakeAdmin({ ...M, active_bank: null });
    const r = await createPayNode(admin, "m1", 250, "RIDE", null, { rideSessionId: "rs-1", accounts: driver });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // fee: 0.30 + 0.40 x ln(1 + 250/100) = 0.8011 -> 0.80, VAT 0.12, total 0.92
    expect(inserted[0]).toMatchObject({ source: "RIDE", ride_session_id: "rs-1", base_fee: 0.8, vat_fee: 0.12, fee_ft: 0.92, net_merchant_settlement: 249.08 });
    expect(inserted[0].routed_bank).toMatchObject({ institution: "Awash Bank", account_masked: "••••6789" });
    expect(inserted[0].routed_wallet).toMatchObject({ institution: "Telebirr", account_masked: "••••3344" });
    expect(inserted[0].payee_accounts).toBe(driver); // kept on the sale for the payment, encrypted when DATA_ENCRYPTION_KEY is set
    expect("payee_accounts" in r.tx).toBe(false);
    expect(JSON.stringify(r.tx)).not.toMatch(/01320123456789|911223344|922334455/);
  });
  it("does not use the partner's own accounts for a ride", async () => {
    const { admin } = fakeAdmin({ ...M, active_bank: { id: "x", institution: "Dashen Bank", account_number: "5555555555" } });
    const r = await createPayNode(admin, "m1", 250, "RIDE", null, { rideSessionId: "rs-1", accounts: driver });
    expect(r.ok && JSON.stringify(r.tx)).not.toMatch(/Dashen/);
  });
});
