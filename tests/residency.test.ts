import { describe, expect, it } from "vitest";
import { cookieShare, dataAllowed, deployRole, uiOrigins } from "@/lib/deploy";
import { aiEnabled, aiLevel, amountBand, buildAiEvent, signBody, verifySignature } from "@/lib/ai-events";
import { CSV_HEADER, csvCell, saleCsvRow, shapeSale } from "@/lib/compliance-sales";

describe("deployment roles (screens on Vercel, data in the country)", () => {
  it("defaults to the whole app in one place, and understands ui and core", () => {
    expect(deployRole({})).toBe("all");
    expect(deployRole({ DEPLOY_ROLE: "UI" })).toBe("ui");
    expect(deployRole({ DEPLOY_ROLE: "core" })).toBe("core");
    expect(deployRole({ DEPLOY_ROLE: "nonsense" })).toBe("all");
  });
  it("the screens-only deployment may never reach data", () => {
    expect(dataAllowed({ DEPLOY_ROLE: "ui" })).toBe(false);
    expect(dataAllowed({ DEPLOY_ROLE: "core" })).toBe(true);
    expect(dataAllowed({})).toBe(true);
  });
  it("only well-formed screens origins are trusted", () => {
    expect(uiOrigins({ UI_ORIGINS: "https://app.2pay.et/, http://localhost:3000 , javascript:alert(1), *, https://x.et/path" })).toEqual(["https://app.2pay.et", "http://localhost:3000"]);
    expect(uiOrigins({})).toEqual([]);
  });
  it("the shared sign-in cookie domain must be a real parent domain", () => {
    expect(cookieShare({ COOKIE_DOMAIN: ".2pay.et" })).toEqual({ domain: ".2pay.et" });
    expect(cookieShare({ COOKIE_DOMAIN: "localhost" })).toEqual({});
    expect(cookieShare({ COOKIE_DOMAIN: "bad domain;" })).toEqual({});
    expect(cookieShare({})).toEqual({});
  });
});

describe("AI event layer", () => {
  const tx = { id: "11111111-1111-4111-8111-111111111111", merchant_id: "22222222-2222-4222-8222-222222222222", amount: 1234.5, source: "TERMINAL", rail: "Telebirr", rail_provider: "arifpay", payer_app: "CBE Birr", settlement_method: "WALLET", tip_amount: 20, latency_ms: 1400, fee_ft: 1.725 };
  const key = "k".repeat(32);
  const at = new Date("2026-10-15T09:30:00Z"); // 12:30 in Addis Ababa

  it("is off unless the level, the address and BOTH secrets are set", () => {
    const full = { AI_EVENT_LEVEL: "features", AI_EVENT_SINK_URL: "https://ai.example", AI_EVENT_SECRET: "s".repeat(20), AI_PSEUDONYM_KEY: "p".repeat(20) };
    expect(aiEnabled(full)).toBe(true);
    for (const missing of ["AI_EVENT_SINK_URL", "AI_EVENT_SECRET", "AI_PSEUDONYM_KEY"]) expect(aiEnabled({ ...full, [missing]: undefined }), missing).toBe(false);
    expect(aiEnabled({ ...full, AI_EVENT_LEVEL: "off" })).toBe(false);
    expect(aiEnabled({ ...full, AI_EVENT_SECRET: "short" })).toBe(false);
    expect(aiLevel({})).toBe("off");
    expect(aiLevel({ AI_EVENT_LEVEL: "FULL" })).toBe("full");
  });
  it("bands the amount", () => {
    expect([50, 100, 499.99, 500, 4999, 5000, 9999, 10000, 49999, 50000].map(amountBand)).toEqual(["<100", "100-499", "100-499", "500-4999", "500-4999", "5000-9999", "5000-9999", "10000-49999", "10000-49999", "50000+"]);
  });
  it("a features-level event holds no identifier and no exact amount", () => {
    const e = buildAiEvent("SETTLED", tx, { key, level: "features", now: at });
    const s = JSON.stringify(e);
    expect(e.v).toBe(1);
    expect(e.features).toMatchObject({ amount_band: "500-4999", hour_eat: 12, weekday_eat: 4, channel: "TERMINAL", institution: "Telebirr", provider: "arifpay", method: "WALLET", payer_app: "CBE Birr", tip: true, latency_ms: 1400, ride: false });
    expect(s).not.toContain(tx.id);
    expect(s).not.toContain(tx.merchant_id);
    expect(s).not.toMatch(/1234|fee_total|"amount"/);
    expect(e.tx).toMatch(/^[0-9a-f]{32}$/);
    expect(e.merchant).toMatch(/^[0-9a-f]{32}$/);
  });
  it("the references are stable for the same sale and differ with another key", () => {
    const a = buildAiEvent("CREATED", tx, { key, level: "features", now: at });
    expect(buildAiEvent("SETTLED", tx, { key, level: "features", now: at }).tx).toBe(a.tx);
    expect(buildAiEvent("CREATED", tx, { key: "z".repeat(32), level: "features", now: at }).tx).not.toBe(a.tx);
    expect(a.tx).not.toBe(a.merchant);
  });
  it("the exact amount, tip and fee go out only at level full", () => {
    const e = buildAiEvent("SETTLED", tx, { key, level: "full", now: at });
    expect(e.features).toMatchObject({ amount: 1234.5, tip_amount: 20, fee_total: 1.725 });
  });
  it("latency belongs only to a settled sale", () => {
    expect(buildAiEvent("CREATED", tx, { key, level: "features", now: at }).features.latency_ms).toBeNull();
  });
  it("signs a batch with its timestamp, and rejects a bad, stale or missing signature", () => {
    const secret = "s".repeat(24);
    const body = JSON.stringify({ events: [] });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signBody(secret, ts, body);
    expect(verifySignature(secret, ts, sig, body)).toBe(true);
    expect(verifySignature(secret, ts, sig, body + " ")).toBe(false);
    expect(verifySignature("other-secret-0123456789ab", ts, sig, body)).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(verifySignature(secret, old, signBody(secret, old, body), body)).toBe(false);
    expect(verifySignature(secret, null, sig, body)).toBe(false);
    expect(verifySignature(secret, ts, null, body)).toBe(false);
    expect(verifySignature(secret, "abc", sig, body)).toBe(false);
  });
});

describe("compliance evidence and its CSV export", () => {
  const row = { id: "abc", created_at: "2026-10-15T10:00:00Z", processing_at: "2026-10-15T10:00:05Z", settled_at: "2026-10-15T10:00:09Z", amount: 250, settled_amount: 250, rail: "Telebirr", rail_provider: "arifpay", settlement_method: "WALLET", routed_bank: { institution: "Awash Bank", account_masked: "••••6789" }, routed_wallet: { institution: "Telebirr", account_masked: "••••3344" }, source: "RIDE", status: "SETTLED", base_fee: 0.9084, vat_fee: 0.1363, net_merchant_settlement: 248.9553, payer_app: "Telebirr", business: "Feres", terminal: "RIDE-AB12", confirmed: true, confirmed_at: "2026-10-15T10:00:09Z" };
  it("shapes a confirmed sale: route, evidence, settle time and fee", () => {
    const s = shapeSale(row);
    expect(s).toMatchObject({ path: "PROVIDER_CONFIRMED", to_institution: "Telebirr", to_account: "••••3344", seconds_to_settle: 4, amount_matches: true, base_fee: 0.9084, vat_fee: 0.1363, net_to_merchant: 248.9553, source: "RIDE" });
  });
  it("tells simulated, awaiting and confirmed apart, and flags an amount that differs", () => {
    expect(shapeSale({ ...row, confirmed: false, rail_provider: null }).path).toBe("SIMULATED");
    expect(shapeSale({ ...row, confirmed: false }).path).toBe("AWAITING_CALLBACK");
    expect(shapeSale({ ...row, settled_amount: 240 }).amount_matches).toBe(false);
    expect(shapeSale({ ...row, base_fee: null, vat_fee: null, net_merchant_settlement: null }).base_fee).toBeNull();
  });
  it("quotes CSV cells and defuses spreadsheet formulas", () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe("");
    for (const bad of ["=1+1", "+cmd", "-2", "@SUM(A1)"]) expect(csvCell(bad).startsWith("'")).toBe(true);
    expect(csvCell("Feres")).toBe("Feres");
    expect(csvCell(0.9084)).toBe("0.9084");
  });
  it("a row has exactly as many cells as the header", () => {
    expect(saleCsvRow(shapeSale(row)).split(",").length).toBe(CSV_HEADER.length);
    expect(saleCsvRow(shapeSale({ ...row, business: "A, B & Co" }))).toContain('"A, B & Co"');
  });
});
