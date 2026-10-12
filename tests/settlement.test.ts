import { describe, expect, it } from "vitest";
import { buildAccounts, normalizeBankAccount, normalizeWalletNumber, pickActive } from "@/lib/settlement";
import { shortName, hueFor, BANKS, WALLETS } from "@/lib/constants";

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("account numbers", () => {
  it("normalises Ethiopian mobile numbers", () => {
    expect(normalizeWalletNumber("0911 22-33 44")).toBe("+251911223344");
    expect(normalizeWalletNumber("+251711223344")).toBe("+251711223344");
    expect(normalizeWalletNumber("251911223344")).toBe("+251911223344");
    expect(normalizeWalletNumber("0511223344")).toBeNull();
    expect(normalizeWalletNumber("12345")).toBeNull();
  });
  it("accepts 6-20 digit bank accounts", () => {
    expect(normalizeBankAccount("1000 1234 5678 9")).toBe("1000123456789");
    expect(normalizeBankAccount("123")).toBeNull();
    expect(normalizeBankAccount("12345678901234567890123")).toBeNull();
    expect(normalizeBankAccount("ABC123456")).toBeNull();
  });
});

describe("saved accounts", () => {
  it("adds a valid account", () => {
    const r = buildAccounts("bank", [{ id: u(1), institution: "Awash Bank", account_number: "0123456789" }], []);
    expect(r.ok && r.accounts[0].account_number).toBe("0123456789");
  });
  it("allows at most 3 of a kind", () => {
    const four = [1, 2, 3, 4].map((n) => ({ id: u(n), institution: "Telebirr", account_number: `091122334${n}` }));
    expect(buildAccounts("wallet", four, []).ok).toBe(false);
  });
  it("only accepts institutions of the right kind", () => {
    expect(buildAccounts("bank", [{ id: u(1), institution: "Telebirr", account_number: "0123456789" }], []).ok).toBe(false);
    expect(buildAccounts("wallet", [{ id: u(1), institution: "Awash Bank", account_number: "0911223344" }], []).ok).toBe(false);
  });
  it("rejects duplicates and malformed ids", () => {
    const dup = [
      { id: u(1), institution: "Awash Bank", account_number: "0123456789" },
      { id: u(2), institution: "Awash Bank", account_number: "0123456789" },
    ];
    expect(buildAccounts("bank", dup, []).ok).toBe(false);
    expect(buildAccounts("bank", [{ id: "x", institution: "Awash Bank", account_number: "0123456789" }], []).ok).toBe(false);
  });
  it("keeps a stored account's own values (the browser never sees full numbers, so it cannot overwrite them)", () => {
    const stored = [{ id: u(1), institution: "Awash Bank", account_number: "0123456789" }];
    const r = buildAccounts("bank", [{ id: u(1), institution: "HACK", account_number: "999999" }], stored);
    expect(r.ok && r.accounts[0]).toEqual(stored[0]);
  });
  it("requires exactly one active account whenever any are saved", () => {
    const list = [{ id: u(1), institution: "Awash Bank", account_number: "0123456789" }];
    expect(pickActive("bank", list, null).ok).toBe(false);
    expect(pickActive("bank", list, "nope").ok).toBe(false);
    const ok = pickActive("bank", list, u(1));
    expect(ok.ok && ok.active?.id).toBe(u(1));
    const none = pickActive("wallet", [], null);
    expect(none.ok && none.active).toBeNull();
  });
});

describe("institution lists and badges", () => {
  it("has the full market lists", () => {
    expect(BANKS.length).toBe(32);
    expect(WALLETS.length).toBe(11);
  });
  it("makes readable, stable badges", () => {
    expect(shortName("Commercial Bank of Ethiopia (CBE)")).toBe("CBE");
    expect(shortName("Awash Bank")).toBe("AW");
    expect(hueFor("Telebirr")).toBe(hueFor("Telebirr"));
    expect(hueFor("Telebirr")).toBeGreaterThanOrEqual(0);
    expect(hueFor("Telebirr")).toBeLessThan(360);
  });
});
