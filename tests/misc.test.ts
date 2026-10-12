import { describe, expect, it } from "vitest";
import { buildEmvQr, crc16, parseEmvQr } from "@/lib/emvqr";
import { compareVersions, updateState } from "@/lib/version";
import { receiptText } from "@/lib/receipts";
import { normalizeTin, validateProfile } from "@/lib/kyc";
import { signSession, verifySession } from "@/lib/session";
import { eatDateKey, eatDayEndISO, eatDayStartISO, referenceFor, toCSV } from "@/lib/format";

describe("EMVCo QR", () => {
  it("computes the standard CRC-16/CCITT-FALSE check value", () => {
    expect(crc16("123456789")).toBe("29B1"); // the published check value for this algorithm
  });
  const input = { merchantName: "NOC Station Megenagna", merchantCity: "Addis Ababa", mcc: "5541", account: { tag: 26, guid: "ET.2PAY", fields: { "01": "TRM-0002" } } };
  it("builds a static and a dynamic payload that read back and verify", () => {
    const s = parseEmvQr(buildEmvQr(input));
    expect(s["01"]).toBe("11");
    expect(s["53"]).toBe("230");
    expect(s["58"]).toBe("ET");
    expect(s["54"]).toBeUndefined();
    const d = parseEmvQr(buildEmvQr({ ...input, amount: 125.5, reference: "2P-ABCD1234" }));
    expect(d["01"]).toBe("12");
    expect(d["54"]).toBe("125.50");
  });
  it("detects a corrupted payload", () => {
    const good = buildEmvQr(input);
    const bad = good.replace("5541", "5542");
    expect(() => parseEmvQr(bad)).toThrow(/CRC/);
  });
  it("refuses fields that cannot be encoded", () => {
    expect(() => buildEmvQr({ ...input, mcc: "12" })).toThrow();
    expect(() => buildEmvQr({ ...input, account: { ...input.account, tag: 10 } })).toThrow();
  });
});

describe("app versions", () => {
  it("compares dotted versions", () => {
    expect(compareVersions("2.1.0", "2.0.9")).toBe(1);
    expect(compareVersions("2.0", "2.0.0")).toBe(0);
    expect(compareVersions("1.9.9", "2.0.0")).toBe(-1);
    expect(compareVersions("10.0.0", "9.9.9")).toBe(1);
  });
  it("decides when to ask for an update", () => {
    const latest = { version: "2.1.0", minVersion: "2.0.0", apk: "/x.apk" };
    expect(updateState("2.1.0", latest)).toBe("current");
    expect(updateState("2.0.0", latest)).toBe("available");
    expect(updateState("1.0.0", latest)).toBe("required");
  });
});

describe("SMS receipts", () => {
  const p = { amount: 1234.5, currency: "ETB", merchant: "Shoa Supermarket", reference: "2P-ABCD1234" };
  it("writes the receipt in the payer's language", () => {
    expect(receiptText("en", p)).toBe("2Pay receipt: 1,234.50 ETB paid to Shoa Supermarket. Ref 2P-ABCD1234. Thank you.");
    expect(receiptText("am", p)).toContain("1,234.50 ብር");
    expect(receiptText("am", p)).toContain("2P-ABCD1234");
    expect(receiptText("xx", p)).toBe(receiptText("en", p));
  });
});

describe("business verification", () => {
  const good = { legal_name: "Shoa Trading PLC", tin: "0012-345-678", business_license: "AA/12/3456", address: "Bole, Addis Ababa", location: "Bole" };
  it("accepts complete details and normalises the TIN", () => {
    const r = validateProfile(good);
    expect(r.ok && r.profile.tin).toBe("0012345678");
  });
  it("rejects missing or malformed details", () => {
    expect(normalizeTin("12345")).toBeNull();
    expect(validateProfile({ ...good, tin: "12345" }).ok).toBe(false);
    expect(validateProfile({ ...good, legal_name: "" }).ok).toBe(false);
    expect(validateProfile({ ...good, business_license: "x" }).ok).toBe(false);
    expect(validateProfile({ ...good, address: "ab" }).ok).toBe(false);
    expect(validateProfile(null).ok).toBe(false);
  });
});

describe("sessions", () => {
  const secret = "x".repeat(40);
  const now = Math.floor(Date.now() / 1000);
  it("round-trips a signed session including its role", async () => {
    const tok = await signSession({ mid: "m1", ph: "+251911223344", rl: "CASHIER", exp: now + 60 }, secret);
    const s = await verifySession(tok, secret);
    expect(s?.mid).toBe("m1");
    expect(s?.rl).toBe("CASHIER");
  });
  it("rejects tampering, a wrong secret, expiry and garbage", async () => {
    const tok = await signSession({ mid: "m1", ph: "p", exp: now + 60 }, secret);
    const [, sig] = tok.split(".");
    const forged = Buffer.from(JSON.stringify({ mid: "admin", ph: "p", rl: "OWNER", exp: now + 999 })).toString("base64url");
    expect(await verifySession(`${forged}.${sig}`, secret)).toBeNull();
    expect(await verifySession(tok, "y".repeat(40))).toBeNull();
    expect(await verifySession(await signSession({ mid: "m1", ph: "p", exp: now - 5 }, secret), secret)).toBeNull();
    expect(await verifySession("not-a-token", secret)).toBeNull();
    expect(await verifySession(undefined, secret)).toBeNull();
    expect(await verifySession(tok, undefined)).toBeNull();
  });
});

describe("formatting and exports", () => {
  it("neutralises spreadsheet formula injection and quotes awkward cells", () => {
    const csv = toCSV(["a", "b"], [["=SUM(A1)", 'say "hi", ok'], [null, 5]]);
    expect(csv).toContain("'=SUM(A1)");
    expect(csv).toContain('"say ""hi"", ok"');
    expect(csv.startsWith("﻿")).toBe(true);
  });
  it("makes stable references", () => {
    expect(referenceFor("02cb7b1f-8675-4af4-bd8c-d0af68458f34")).toBe("2P-02CB7B1F");
  });
  it("uses Addis Ababa (UTC+3) day boundaries", () => {
    expect(eatDayStartISO("2026-10-11")).toBe("2026-10-10T21:00:00.000Z");
    expect(eatDayEndISO("2026-10-11")).toBe("2026-10-11T21:00:00.000Z");
    expect(eatDateKey(new Date("2026-10-10T22:00:00Z"))).toBe("2026-10-11"); // 01:00 EAT already the next day
  });
});
