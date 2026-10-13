import { afterEach, describe, expect, it } from "vitest";
import { classifyChange, signStepUp, verifyStepUp, STEP_UP_TTL_S, type Snapshot } from "@/lib/settlement-security";
import { ALL_PAYER_APPS, POPULAR_PAYER_APPS, chooseRoute, findPayerApp } from "@/lib/routing-hub";
import { fillTemplate, needsPayload, platformOf, resolveAppLink, usableTemplate } from "@/lib/applinks";
import { buildEthQr, parseTemplate } from "@/lib/ethqr";
import { parseEmvQr } from "@/lib/emvqr";
import { appRequiredFor, isNodeApp } from "@/lib/node-app";
import { appLinkFor } from "@/lib/team-invite";

const acct = (id: string, institution: string, n = "1000123456789") => ({ id, institution, account_number: n });
const bank = acct("b1", "Awash Bank");
const wallet = acct("w1", "Telebirr", "+251911223344");
const empty: Snapshot = { saved_banks: [], saved_wallets: [], active_bank: null, active_wallet: null };
const full: Snapshot = { saved_banks: [bank], saved_wallets: [wallet], active_bank: bank, active_wallet: wallet };

describe("settlement vault: what needs the owner's code", () => {
  it("the very first setup is free: there is nothing yet to divert", () => {
    expect(classifyChange(empty, { saved_banks: [bank], saved_wallets: [], active_bank: bank, active_wallet: null })).toBe("SETUP");
    expect(classifyChange(empty, full)).toBe("SETUP");
  });

  it("no change is no change", () => {
    expect(classifyChange(full, full)).toBe("NONE");
  });

  it("removing an account needs the code", () => {
    expect(classifyChange(full, { ...full, saved_wallets: [], active_wallet: null })).toBe("SENSITIVE");
    expect(classifyChange(full, { ...full, saved_banks: [], active_bank: null })).toBe("SENSITIVE");
  });

  it("editing an account's number or bank needs the code (same id, different destination)", () => {
    const edited = { ...bank, account_number: "1000999999999" };
    expect(classifyChange(full, { ...full, saved_banks: [edited], active_bank: edited })).toBe("SENSITIVE");
    const moved = { ...bank, institution: "Dashen Bank" };
    expect(classifyChange(full, { ...full, saved_banks: [moved], active_bank: moved })).toBe("SENSITIVE");
  });

  it("switching which account receives money needs the code", () => {
    const other = acct("b2", "Dashen Bank");
    const both = { ...full, saved_banks: [bank, other] };
    expect(classifyChange(full, both)).toBe("NONE"); // adding an extra, unused account moves nothing
    expect(classifyChange(both, { ...both, active_bank: other })).toBe("SENSITIVE");
  });

  it("adding a second kind when money already flows somewhere changes routing, so it needs the code", () => {
    const onlyBank: Snapshot = { saved_banks: [bank], saved_wallets: [], active_bank: bank, active_wallet: null };
    expect(classifyChange(onlyBank, full)).toBe("SENSITIVE"); // the new wallet becomes active: part of the money now goes there
    expect(classifyChange(onlyBank, { ...full, active_wallet: null })).toBe("NONE");
  });
});

describe("the step-up pass", () => {
  const secret = "s".repeat(40);
  const now = Date.parse("2026-10-13T10:00:00Z");

  it("accepts a fresh pass for the same business and phone", () => {
    const p = signStepUp("m1", "+251911000001", secret, now);
    expect(verifyStepUp(p, "m1", "+251911000001", secret, now + 1000)).toBe(true);
  });

  it("expires after five minutes", () => {
    const p = signStepUp("m1", "+251911000001", secret, now);
    expect(STEP_UP_TTL_S).toBe(300);
    expect(verifyStepUp(p, "m1", "+251911000001", secret, now + 301_000)).toBe(false);
  });

  it("is useless for another business, another phone, another secret, or when tampered with", () => {
    const p = signStepUp("m1", "+251911000001", secret, now);
    expect(verifyStepUp(p, "m2", "+251911000001", secret, now)).toBe(false);
    expect(verifyStepUp(p, "m1", "+251911000002", secret, now)).toBe(false);
    expect(verifyStepUp(p, "m1", "+251911000001", "t".repeat(40), now)).toBe(false);
    const [body, sig] = p.split(".");
    const forged = Buffer.from(JSON.stringify({ k: "stepup", mid: "m1", ph: "+251911000001", exp: 9_999_999_999 })).toString("base64url");
    expect(verifyStepUp(`${forged}.${sig}`, "m1", "+251911000001", secret, now)).toBe(false);
    expect(verifyStepUp(`${body}.x`, "m1", "+251911000001", secret, now)).toBe(false);
    expect(verifyStepUp(undefined, "m1", "+251911000001", secret, now)).toBe(false);
    expect(verifyStepUp(p, "m1", "+251911000001", undefined, now)).toBe(false);
  });
});

describe("customer routing hub", () => {
  const route = (appName: string | null, b: string | null, w: string | null) => chooseRoute(appName ? findPayerApp(appName) : null, { bank: b, wallet: w });

  it("a wallet customer pays the merchant's wallet, a bank customer the merchant's bank", () => {
    expect(route("CBE Birr", "Awash Bank", "Telebirr")).toMatchObject({ method: "wallet", institution: "Telebirr", reason: "same-kind" });
    expect(route("Dashen Bank", "Awash Bank", "Telebirr")).toMatchObject({ method: "bank", institution: "Awash Bank", reason: "same-kind" });
  });

  it("the same institution wins: an internal transfer", () => {
    expect(route("Awash Bank", "Awash Bank", "Telebirr")).toMatchObject({ method: "bank", reason: "same-institution" });
    expect(route("Telebirr", "Awash Bank", "Telebirr")).toMatchObject({ method: "wallet", reason: "same-institution" });
    expect(route("AwashBirr", "Awash Bank", "Telebirr")).toMatchObject({ method: "bank", reason: "same-institution" }); // a bank's own wallet
    expect(route("CBE Birr", "Commercial Bank of Ethiopia (CBE)", "Telebirr")).toMatchObject({ method: "bank", reason: "same-institution" });
  });

  it("with one account configured, that account is used whatever the customer's app", () => {
    expect(route("Telebirr", "Awash Bank", null)).toMatchObject({ method: "bank", institution: "Awash Bank", reason: "only-option" });
    expect(route("Dashen Bank", null, "Telebirr")).toMatchObject({ method: "wallet", reason: "only-option" });
  });

  it("no active account means no route", () => {
    expect(route("Telebirr", null, null)).toBeNull();
  });

  it("only known national apps are accepted from the customer", () => {
    expect(findPayerApp("Telebirr")).toEqual({ name: "Telebirr", kind: "wallet" });
    expect(findPayerApp("Awash Bank")).toEqual({ name: "Awash Bank", kind: "bank" });
    for (const bad of ["", "other", "Evil Bank", "<script>", 5, null, undefined]) expect(findPayerApp(bad)).toBeNull();
  });

  it("the grid leads with the popular apps and the full list contains them all", () => {
    expect(POPULAR_PAYER_APPS.length).toBeGreaterThanOrEqual(6);
    expect(POPULAR_PAYER_APPS.every((p) => ALL_PAYER_APPS.some((a) => a.name === p.name && a.kind === p.kind))).toBe(true);
  });
});

describe("opening the customer's app", () => {
  const vars = { url: "https://checkout.example/pay?id=1&x=2", payload: "000201PAYLOAD", amount: "800.00", ref: "2P-ABC123" };
  const cfg = JSON.stringify({
    Telebirr: "https://app.example/pay?u={url}",
    "CBE Birr": {
      android: "intent://pay?data={payload}#Intent;scheme=cbe;package=com.example.cbe;S.browser_fallback_url={url};end",
      ios: "cbe://pay?data={payload}",
      any: "https://cbe.example/pay?u={url}",
    },
    Evil: "javascript:alert(1)",
    "Awash Bank": { any: "data:text/html,boo" },
  });

  it("detects the phone", () => {
    expect(platformOf("Mozilla/5.0 (Linux; Android 14) Chrome/120")).toBe("android");
    expect(platformOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe("ios");
    expect(platformOf("Mozilla/5.0 (Windows NT 10.0)")).toBe("other");
    expect(platformOf(null)).toBe("other");
  });

  it("fills placeholders, URL-encoded", () => {
    expect(fillTemplate("x://p?u={url}&a={amount}", vars)).toBe(`x://p?u=${encodeURIComponent(vars.url)}&a=800.00`);
    expect(fillTemplate("x://p?d={payload}", { url: "u" })).toBeUndefined(); // needs a payload we do not have
  });

  it("a string template works on every phone", () => {
    expect(resolveAppLink(cfg, "Telebirr", "ios", vars)).toBe(`https://app.example/pay?u=${encodeURIComponent(vars.url)}`);
    expect(resolveAppLink(cfg, "Telebirr", "android", vars)).toContain("https://app.example/");
  });

  it("per-phone templates: the Android intent link only on Android, the iOS link on iPhone, a web link otherwise", () => {
    expect(resolveAppLink(cfg, "CBE Birr", "android", vars)).toMatch(/^intent:\/\/pay\?data=000201PAYLOAD#Intent;scheme=cbe;package=com\.example\.cbe;/);
    expect(resolveAppLink(cfg, "CBE Birr", "ios", vars)).toBe("cbe://pay?data=000201PAYLOAD");
    expect(resolveAppLink(cfg, "CBE Birr", "other", vars)).toContain("https://cbe.example/pay?u=");
  });

  it("falls back to the web link when the payload is missing", () => {
    expect(resolveAppLink(cfg, "CBE Birr", "android", { url: vars.url })).toContain("https://cbe.example/pay?u=");
  });

  it("never emits dangerous or unknown things", () => {
    expect(usableTemplate("javascript:alert(1)")).toBe(false);
    expect(usableTemplate("data:text/html,x")).toBe(false);
    expect(resolveAppLink(cfg, "Evil", "android", vars)).toBeUndefined();
    expect(resolveAppLink(cfg, "Awash Bank", "android", vars)).toBeUndefined();
    expect(resolveAppLink(cfg, "Not configured", "android", vars)).toBeUndefined();
    expect(resolveAppLink("not json", "Telebirr", "android", vars)).toBeUndefined();
    expect(resolveAppLink(undefined, "Telebirr", "android", vars)).toBeUndefined();
  });

  it("knows when a template needs the ETHQR payload", () => {
    expect(needsPayload(cfg, "CBE Birr")).toBe(true);
    expect(needsPayload(cfg, "Telebirr")).toBe(false);
    expect(needsPayload("bad", "Telebirr")).toBe(false);
  });
});

describe("dynamic ETHQR assembly", () => {
  // A TEST FIXTURE shaped like an EMVCo account template. It is NOT the real national scheme template, which must come from EthSwitch.
  const tpl = JSON.stringify({ tag: 26, guid: "TEST.FIXTURE", fields: { "01": "{account}", "02": "{institution}" } });
  const input = { merchantName: "NOC Station Megenagna", category: "Fuel", city: null, account: { institution: "Awash Bank", account_number: "1000123456789" }, amount: 800, reference: "2P-ABC123" };

  it("builds a valid EMVCo payload: the account, the exact amount, our reference, and a correct CRC", () => {
    const p = buildEthQr(input, tpl)!;
    expect(p).toMatch(/^000201/);
    const tags = parseEmvQr(p); // throws on a bad CRC
    expect(tags["01"]).toBe("12"); // dynamic QR
    expect(tags["54"]).toBe("800.00");
    expect(tags["58"]).toBe("ET");
    expect(tags["53"]).toBe("230");
    expect(tags["52"]).toBe("5541"); // fuel
    expect(tags["26"]).toContain("1000123456789");
    expect(tags["62"]).toContain("2P-ABC123");
  });

  it("is built only when the scheme template is configured (never guessed)", () => {
    expect(buildEthQr(input, undefined)).toBeNull();
    expect(buildEthQr(input, "")).toBeNull();
    expect(buildEthQr(input, "not json")).toBeNull();
    expect(parseTemplate(JSON.stringify({ tag: 99, guid: "x" }))).toBeNull(); // tag outside 26-51
    expect(parseTemplate(JSON.stringify({ tag: 26 }))).toBeNull();
  });

  it("falls back (null) rather than send a broken QR when a field does not fit", () => {
    expect(buildEthQr({ ...input, account: { institution: "x", account_number: "9".repeat(120) } }, tpl)).toBeNull();
  });
});

describe("waiter app lock", () => {
  const req = (ua?: string) => new Request("http://x/", { headers: ua ? { "user-agent": ua } : {} });
  const env = { ...process.env };
  afterEach(() => {
    process.env.AUTH_ENFORCED = env.AUTH_ENFORCED;
    process.env.ALLOW_BROWSER_NODES = env.ALLOW_BROWSER_NODES;
  });

  it("recognises the Android app by its user agent", () => {
    expect(isNodeApp(req("Mozilla/5.0 (Linux; Android 14) TwoPayMerchantApp/2.3.0"))).toBe(true);
    expect(isNodeApp(req("Mozilla/5.0 (Linux; Android 14) Chrome/120"))).toBe(false);
    expect(isNodeApp(req())).toBe(false);
  });

  it("waiters need the app when sign-in is enforced; cashiers and owners do not", () => {
    process.env.AUTH_ENFORCED = "true";
    delete process.env.ALLOW_BROWSER_NODES;
    expect(appRequiredFor("WAITER", req("Chrome"))).toBe(true);
    expect(appRequiredFor("WAITER", req("TwoPayMerchantApp/2.3.0"))).toBe(false);
    expect(appRequiredFor("CASHIER", req("Chrome"))).toBe(false);
    expect(appRequiredFor("OWNER", req("Chrome"))).toBe(false);
  });

  it("test mode and the operator override let a browser through", () => {
    delete process.env.AUTH_ENFORCED;
    expect(appRequiredFor("WAITER", req("Chrome"))).toBe(false);
    process.env.AUTH_ENFORCED = "true";
    process.env.ALLOW_BROWSER_NODES = "true";
    expect(appRequiredFor("WAITER", req("Chrome"))).toBe(false);
  });

  it("the in-app activation link carries the token in the twopay:// scheme", () => {
    expect(appLinkFor("abc")).toBe("twopay://activate/abc");
  });
});
