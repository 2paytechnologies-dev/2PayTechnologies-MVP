import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_TOKEN_RE, buildDriverAccounts, chooseDriverAccount, newApiKey, newSessionToken, parseRideIntent, railToInstitution, sessionLinks, sha256 } from "@/lib/ride";
import { getRailLogo, railSlug } from "@/lib/rail-logos";

const intent = (over: Record<string, unknown> = {}) => ({ partner_ride_id: "ride-77", driver_id: "drv_9", fare_amount: 250, currency: "ETB", driver_wallet_accounts: [{ rail: "TELEBIRR", account_number: "0911223344" }, { rail: "CBE_BIRR", account_number: "0922334455" }], ...over });

describe("ride-hailing: rail codes", () => {
  it("maps partner rail codes to 2Pay institutions", () => {
    expect(railToInstitution("TELEBIRR")).toBe("Telebirr");
    expect(railToInstitution("CBE_BIRR")).toBe("CBE Birr");
    expect(railToInstitution("cbe")).toBe("Commercial Bank of Ethiopia (CBE)");
    expect(railToInstitution("Awash Bank")).toBe("Awash Bank");
    expect(railToInstitution("AWASH_BIRR")).toBe("AwashBirr");
  });
  it("refuses anything that is not a known bank or wallet", () => {
    for (const bad of ["NOPE", "", "  ", 5, null, undefined, { a: 1 }]) expect(railToInstitution(bad)).toBeNull();
  });
});

describe("ride-hailing: the driver's accounts", () => {
  it("normalises wallet numbers and bank numbers and gives each account an id", () => {
    const r = buildDriverAccounts([{ rail: "TELEBIRR", account_number: "0911 22 33 44" }, { rail: "AWASH", account_number: "0132-0123456789" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((a) => [a.institution, a.account_number])).toEqual([["Telebirr", "+251911223344"], ["Awash Bank", "01320123456789"]]);
    expect(new Set(r.value.map((a) => a.id)).size).toBe(2);
  });
  it("needs at least one, at most four, no duplicates, valid numbers", () => {
    expect(buildDriverAccounts([]).ok).toBe(false);
    expect(buildDriverAccounts("x").ok).toBe(false);
    expect(buildDriverAccounts(Array.from({ length: 5 }, (_, i) => ({ rail: "TELEBIRR", account_number: `091122334${i}` }))).ok).toBe(false);
    expect(buildDriverAccounts([{ rail: "TELEBIRR", account_number: "0911223344" }, { rail: "TELEBIRR", account_number: "+251911223344" }]).ok).toBe(false);
    expect(buildDriverAccounts([{ rail: "TELEBIRR", account_number: "12" }]).ok).toBe(false);
    expect(buildDriverAccounts([{ rail: "AWASH", account_number: "0911223344x" }]).ok).toBe(false);
  });
});

describe("ride-hailing: the checkout intent", () => {
  it("accepts a well-formed intent", () => {
    const r = parseRideIntent(intent());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ partnerRideId: "ride-77", driverId: "drv_9", fare: 250 });
  });
  it("rejects a bad fare", () => {
    for (const fare of [0, -1, "250", NaN, Infinity, 1_000_001, 10.005]) expect(parseRideIntent(intent({ fare_amount: fare })).ok, String(fare)).toBe(false);
    expect(parseRideIntent(intent({ fare_amount: 99.5 })).ok).toBe(true);
  });
  it("rejects bad ids and currencies", () => {
    expect(parseRideIntent(intent({ partner_ride_id: "" })).ok).toBe(false);
    expect(parseRideIntent(intent({ partner_ride_id: "a b" })).ok).toBe(false);
    expect(parseRideIntent(intent({ partner_ride_id: "x".repeat(65) })).ok).toBe(false);
    expect(parseRideIntent(intent({ driver_id: "<script>" })).ok).toBe(false);
    expect(parseRideIntent(intent({ currency: "USD" })).ok).toBe(false);
    expect(parseRideIntent(null).ok).toBe(false);
  });
});

describe("ride-hailing: keys and links", () => {
  it("makes an API key whose hash, not the key, is what is kept", () => {
    const k = newApiKey();
    expect(k.key).toMatch(/^2pay_rk_[A-Za-z0-9_-]{43}$/);
    expect(k.hash).toBe(sha256(k.key));
    expect(k.hint).toBe(k.key.slice(-4));
    expect(newApiKey().key).not.toBe(k.key);
  });
  it("makes a 256-bit checkout token that the link check accepts", () => {
    const s = newSessionToken();
    expect(SESSION_TOKEN_RE.test(s.token)).toBe(true);
    expect(s.hash).toBe(sha256(s.token));
    expect(SESSION_TOKEN_RE.test("short")).toBe(false);
  });
  it("builds the deep link, the Android intent and the web fallback", () => {
    const { token } = newSessionToken();
    const l = sessionLinks("https://pay.example", token);
    expect(l.terminal_url).toBe(`https://pay.example/terminal?session_token=${token}`);
    expect(l.deep_link).toBe(`twopay://checkout?token=${token}`);
    expect(l.android_intent).toContain("package=com.twopay.merchant");
    expect(l.android_intent).toContain(encodeURIComponent(l.terminal_url));
  });
});

describe("ride-hailing: choosing the driver's account for a passenger's app", () => {
  const accts = [
    { id: "a", institution: "Telebirr" },
    { id: "b", institution: "CBE Birr" },
    { id: "c", institution: "Awash Bank" },
  ];
  it("a passenger who taps an account directly gets that one", () => expect(chooseDriverAccount({ name: "Telebirr", kind: "wallet" }, accts, "c")?.id).toBe("c"));
  it("same institution first (an internal transfer)", () => expect(chooseDriverAccount({ name: "Awash Bank", kind: "bank" }, accts)?.id).toBe("c"));
  it("a wallet's bank family counts as the same institution", () => {
    expect(chooseDriverAccount({ name: "Commercial Bank of Ethiopia (CBE)", kind: "bank" }, accts)?.id).toBe("b");
  });
  it("otherwise the same kind, then the first listed", () => {
    expect(chooseDriverAccount({ name: "M-Pesa", kind: "wallet" }, accts)?.id).toBe("a");
    expect(chooseDriverAccount({ name: "Dashen Bank", kind: "bank" }, accts)?.id).toBe("c");
    expect(chooseDriverAccount(null, accts)?.id).toBe("a");
    expect(chooseDriverAccount({ name: "Dashen Bank", kind: "bank" }, [{ id: "w", institution: "Telebirr" }])?.id).toBe("w");
  });
  it("an unknown account id is ignored (the caller rejects it first)", () => expect(chooseDriverAccount(null, accts, "zzz")?.id).toBe("a"));
  it("no accounts, no choice", () => expect(chooseDriverAccount(null, [])).toBeNull());
});

describe("bank and wallet logos", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("slugs names and rail codes the same way", () => {
    expect(railSlug("Awash Bank")).toBe("awash-bank");
    expect(railSlug("AWASH_BANK")).toBe("awash-bank");
    expect(railSlug("Commercial Bank of Ethiopia (CBE)")).toBe("cbe");
    expect(railSlug("CBE_BIRR")).toBe("cbe-birr");
    expect(railSlug("Telebirr")).toBe("telebirr");
  });
  it("has no logo (so the initials badge is drawn) unless one is supplied", () => {
    expect(getRailLogo("Telebirr", undefined)).toBe("");
    expect(getRailLogo("", undefined)).toBe("");
  });
  it("can use a CDN you configure, but only https and only with {slug}", () => {
    expect(getRailLogo("Awash Bank", "https://cdn.example/rails/{slug}.svg")).toBe("https://cdn.example/rails/awash-bank.svg");
    expect(getRailLogo("Awash Bank", "http://cdn.example/{slug}.svg")).toBe("");
    expect(getRailLogo("Awash Bank", "https://cdn.example/fixed.svg")).toBe("");
    expect(getRailLogo("Awash Bank", "javascript:alert({slug})")).toBe("");
  });
});
