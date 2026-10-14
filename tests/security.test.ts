import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { isSealed, openAccount, openAccounts, openField, sealAccount, sealAccounts, sealField, tryOpenField, encryptionActive } from "@/lib/fieldcrypt";
import { FAYDA_COOKIE, buildAuthorizeUrl, claimText, faydaConfig, pkce, readState, signJwtRs256, signState, subjectHash, verifyJwtRs256, type Jwks } from "@/lib/fayda";
import { chooseRoute, findPayerApp, transferFor } from "@/lib/routing-hub";
import { bankCodeFor, fillTemplate, resolveAppLink } from "@/lib/applinks";

const KEY = randomBytes(32).toString("base64");
const KEY2 = randomBytes(32).toString("base64");
const env = { ...process.env };
afterEach(() => {
  for (const k of ["DATA_ENCRYPTION_KEY", "DATA_ENCRYPTION_KEY_PREV", "FAYDA_ISSUER", "FAYDA_CLIENT_ID", "FAYDA_PRIVATE_JWK", "PUBLIC_BASE_URL", "FAYDA_ALLOW_INSECURE", "FAYDA_REDIRECT_URI"]) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
});

describe("encryption at rest (AES-256-GCM)", () => {
  beforeEach(() => {
    process.env.DATA_ENCRYPTION_KEY = KEY;
  });

  it("does nothing, honestly, until a key is configured", () => {
    delete process.env.DATA_ENCRYPTION_KEY;
    expect(encryptionActive()).toBe(false);
    expect(sealField("1000123456789", "account")).toBe("1000123456789");
    expect(isSealed("1000123456789")).toBe(false);
  });

  it("seals a value so the plain text is not in what is stored, and opens it again", () => {
    const sealed = sealField("1000123456789", "account");
    expect(encryptionActive()).toBe(true);
    expect(isSealed(sealed)).toBe(true);
    expect(sealed).toMatch(/^enc:v1:[0-9a-f]{8}:/);
    expect(sealed).not.toContain("1000123456789");
    expect(openField(sealed, "account")).toBe("1000123456789");
  });

  it("uses a fresh nonce every time (the same value never looks the same twice)", () => {
    expect(sealField("same", "tin")).not.toBe(sealField("same", "tin"));
  });

  it("detects any change to the stored value", () => {
    const sealed = sealField("1000123456789", "account");
    const parts = sealed.split(":");
    parts[5] = Buffer.from(Buffer.from(parts[5], "base64url").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64url");
    expect(() => openField(parts.join(":"), "account")).toThrow();
    expect(tryOpenField(parts.join(":"), "account")).toBeNull();
  });

  it("will not open a value as a different kind of field (a TIN cannot be replayed as an account number)", () => {
    const sealed = sealField("0012345678", "tin");
    expect(() => openField(sealed, "account")).toThrow();
    expect(() => openField(sealed, "national-id")).toThrow();
  });

  it("passes plain values written before encryption through, so old rows keep working", () => {
    expect(openField("1000123456789", "account")).toBe("1000123456789");
    expect(tryOpenField(null, "tin")).toBeNull();
    const once = sealField("x", "tin");
    expect(sealField(once, "tin")).toBe(once);
  });

  it("supports key rotation: the old key still opens, only the new key seals", () => {
    const old = sealField("1000123456789", "account");
    process.env.DATA_ENCRYPTION_KEY = KEY2;
    expect(() => openField(old, "account")).toThrow(); // old key not configured any more
    process.env.DATA_ENCRYPTION_KEY_PREV = KEY;
    expect(openField(old, "account")).toBe("1000123456789");
    const fresh = sealField("1000123456789", "account");
    expect(fresh.split(":")[2]).not.toBe(old.split(":")[2]); // sealed with the new key id
    delete process.env.DATA_ENCRYPTION_KEY_PREV;
    expect(openField(fresh, "account")).toBe("1000123456789");
  });

  it("ignores a key that is not 32 bytes (never a weak key)", () => {
    process.env.DATA_ENCRYPTION_KEY = Buffer.from("too short").toString("base64");
    expect(encryptionActive()).toBe(false);
  });

  it("seals an account's number, keeps the last four digits beside it, and opens the account again", () => {
    const a = { id: "b1", institution: "Awash Bank", account_number: "1000123456789" };
    const s = sealAccount(a);
    expect(s.account_number).not.toContain("1000123456789");
    expect(s.last4).toBe("6789");
    expect(s.institution).toBe("Awash Bank");
    expect(openAccount(s)).toEqual(a);
    expect(openAccounts(sealAccounts([a, { ...a, id: "b2" }])).map((x) => x.id)).toEqual(["b1", "b2"]);
  });

  it("an account that cannot be decrypted is dropped from use, never guessed", () => {
    const s = sealAccount({ id: "b1", institution: "Awash Bank", account_number: "1000123456789" });
    process.env.DATA_ENCRYPTION_KEY = KEY2;
    expect(openAccount(s)).toBeNull();
    expect(openAccounts([s])).toEqual([]);
  });
});

describe("Fayda national ID sign-in", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const priv = { ...privateKey.export({ format: "jwk" }), kid: "k1" };
  const pub = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" };
  const jwks: Jwks = { keys: [pub] };
  const now = Date.now();
  const claims = (over: Record<string, unknown> = {}) => ({ iss: "https://id.example", aud: "2pay", sub: "uin-123", nonce: "n1", exp: Math.floor(now / 1000) + 300, ...over });

  it("signs and verifies a token, and checks issuer, audience, expiry and nonce", () => {
    const t = signJwtRs256(claims(), priv);
    expect(verifyJwtRs256(t, jwks, { iss: "https://id.example", aud: "2pay", nonce: "n1" }, now).sub).toBe("uin-123");
    expect(() => verifyJwtRs256(t, jwks, { iss: "https://evil.example", aud: "2pay" }, now)).toThrow(/issuer/);
    expect(() => verifyJwtRs256(t, jwks, { iss: "https://id.example", aud: "someone-else" }, now)).toThrow(/audience/);
    expect(() => verifyJwtRs256(t, jwks, { iss: "https://id.example", aud: "2pay", nonce: "other" }, now)).toThrow(/nonce/);
    expect(() => verifyJwtRs256(signJwtRs256(claims({ exp: Math.floor(now / 1000) - 3600 }), priv), jwks, { iss: "https://id.example", aud: "2pay" }, now)).toThrow(/expired/);
  });

  it("refuses a token signed by a different key, an altered token, and unsafe algorithms", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" });
    expect(() => verifyJwtRs256(signJwtRs256(claims(), { ...other, kid: "k1" }), jwks, { iss: "https://id.example", aud: "2pay" }, now)).toThrow(/signature/);
    const t = signJwtRs256(claims(), priv);
    const [h, p, s] = t.split(".");
    const evil = Buffer.from(JSON.stringify({ ...claims(), sub: "someone-else" })).toString("base64url");
    expect(() => verifyJwtRs256(`${h}.${evil}.${s}`, jwks, { iss: "https://id.example", aud: "2pay" }, now)).toThrow(/signature/);
    const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${p}.`;
    expect(() => verifyJwtRs256(none, jwks, { iss: "https://id.example", aud: "2pay" }, now)).toThrow();
    const hs = `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${p}.${s}`;
    expect(() => verifyJwtRs256(hs, jwks, { iss: "https://id.example", aud: "2pay" }, now)).toThrow(/unsupported/);
    expect(() => verifyJwtRs256("not.a.jwt.at.all", jwks, { iss: "x", aud: "y" }, now)).toThrow();
  });

  it("reads a name whether the provider sends a string, {value} or a multilingual list", () => {
    expect(claimText("Abebe Kebede")).toBe("Abebe Kebede");
    expect(claimText({ value: "Abebe Kebede" })).toBe("Abebe Kebede");
    expect(claimText([{ language: "am", value: "አበበ ከበደ" }, { language: "eng", value: "Abebe Kebede" }])).toBe("Abebe Kebede");
    expect(claimText([{ language: "am", value: "አበበ ከበደ" }])).toBe("አበበ ከበደ");
    expect(claimText(undefined)).toBeNull();
    expect(claimText("   ")).toBeNull();
  });

  it("keeps a keyed fingerprint of the person, never the ID", () => {
    const h = subjectHash("uin-123", "s".repeat(40));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("uin-123");
    expect(subjectHash("uin-123", "s".repeat(40))).toBe(h);
    expect(subjectHash("uin-124", "s".repeat(40))).not.toBe(h);
    expect(subjectHash("uin-123", "t".repeat(40))).not.toBe(h);
  });

  it("builds a standard authorization request with PKCE", () => {
    const { verifier, challenge } = pkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    const cfg = { issuer: "https://id.example", clientId: "2pay", redirectUri: "https://app.example/api/fayda/callback", scopes: "openid profile", privateJwk: priv };
    const u = new URL(buildAuthorizeUrl(cfg, { issuer: cfg.issuer, authorization_endpoint: "https://id.example/authorize", token_endpoint: "x", userinfo_endpoint: "y", jwks_uri: "z" }, { state: "s1", nonce: "n1", challenge, lang: "am" }));
    expect(u.origin + u.pathname).toBe("https://id.example/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(challenge);
    expect(u.searchParams.get("ui_locales")).toBe("am");
    expect(u.searchParams.get("redirect_uri")).toBe(cfg.redirectUri);
  });

  it("the 'where were we' cookie is signed, expires, and cannot be altered", () => {
    const s = { state: "s1", nonce: "n1", verifier: "v", mid: "m", kind: "OWNER" as const, id: "m", exp: Math.floor(now / 1000) + 600 };
    const tok = signState(s, "k".repeat(40));
    expect(FAYDA_COOKIE).toBe("2pay_fayda");
    expect(readState(tok, "k".repeat(40), now)).toEqual(s);
    expect(readState(tok, "j".repeat(40), now)).toBeNull();
    expect(readState(tok, "k".repeat(40), now + 601_000)).toBeNull();
    const [body, sig] = tok.split(".");
    const forged = Buffer.from(JSON.stringify({ ...s, mid: "other" })).toString("base64url");
    expect(readState(`${forged}.${sig}`, "k".repeat(40), now)).toBeNull();
    expect(readState(`${body}.x`, "k".repeat(40), now)).toBeNull();
    expect(readState(undefined, "k".repeat(40), now)).toBeNull();
  });

  it("is off until it is configured, and only accepts https (or a local test provider when explicitly allowed)", () => {
    expect(faydaConfig()).toBeNull();
    process.env.FAYDA_ISSUER = "https://id.example";
    process.env.FAYDA_CLIENT_ID = "2pay";
    process.env.FAYDA_PRIVATE_JWK = JSON.stringify(priv);
    process.env.PUBLIC_BASE_URL = "https://app.example";
    expect(faydaConfig()?.redirectUri).toBe("https://app.example/api/fayda/callback");
    process.env.FAYDA_ISSUER = "http://id.example";
    expect(faydaConfig()).toBeNull(); // plain http to a real host: refused
    process.env.FAYDA_ISSUER = "http://localhost:4040";
    expect(faydaConfig()).toBeNull(); // local http only when explicitly allowed
    process.env.FAYDA_ALLOW_INSECURE = "true";
    expect(faydaConfig()).not.toBeNull();
    process.env.FAYDA_PRIVATE_JWK = JSON.stringify(pub); // a PUBLIC key is not a private key
    expect(faydaConfig()).toBeNull();
  });
});

describe("opening the right screen of the customer's bank app", () => {
  it("same bank is an internal transfer; another bank is the interbank (EthSwitch) screen; another wallet is a wallet transfer", () => {
    const app = (n: string) => findPayerApp(n);
    expect(transferFor(app("Awash Bank"), "Awash Bank", "bank")).toBe("internal");
    expect(transferFor(app("AwashBirr"), "Awash Bank", "bank")).toBe("internal"); // a bank's own wallet counts as the same family
    expect(transferFor(app("Dashen Bank"), "Awash Bank", "bank")).toBe("interbank");
    expect(transferFor(app("Dashen Bank"), "Telebirr", "wallet")).toBe("wallet");
    expect(transferFor(app("Telebirr"), "Awash Bank", "bank")).toBe("interbank"); // a wallet paying a bank account
    expect(transferFor(null, "Awash Bank", "bank")).toBe("interbank");
  });

  it("chooseRoute carries the transfer kind with the account it picked", () => {
    const m = { bank: "Awash Bank", wallet: "Telebirr" };
    expect(chooseRoute(findPayerApp("Awash Bank"), m)).toMatchObject({ method: "bank", transfer: "internal" });
    expect(chooseRoute(findPayerApp("Dashen Bank"), m)).toMatchObject({ method: "bank", institution: "Awash Bank", transfer: "interbank" });
    expect(chooseRoute(findPayerApp("CBE Birr"), m)).toMatchObject({ method: "wallet", institution: "Telebirr", transfer: "wallet" });
  });

  const vars = { url: "https://pay.example/x", amount: "800.00", ref: "2P-1", account: "1000123456789", bank: "Awash Bank", bank_code: "AWSB", name: "NOC Station" };
  const cfg = JSON.stringify({
    "Dashen Bank": {
      internal: { any: "dashen://own?to={account}&amt={amount}" },
      interbank: { android: "intent://other-bank?bank={bank_code}&acct={account}&amt={amount}&ref={ref}#Intent;scheme=dashen;package=com.example.dashen;S.browser_fallback_url={url};end", ios: "dashen://other-bank?bank={bank_code}&acct={account}&amt={amount}&ref={ref}" },
      wallet: { any: "dashen://wallet?to={account}&amt={amount}" },
      any: "https://dashen.example/pay?u={url}",
    },
  });

  it("different banks: opens the app's other-bank screen with the merchant's bank, account and amount filled in", () => {
    const android = resolveAppLink(cfg, "Dashen Bank", "android", vars, "interbank")!;
    expect(android).toMatch(/^intent:\/\/other-bank\?bank=AWSB&acct=1000123456789&amt=800\.00&ref=2P-1#Intent;scheme=dashen;package=com\.example\.dashen;/);
    expect(resolveAppLink(cfg, "Dashen Bank", "ios", vars, "interbank")).toBe("dashen://other-bank?bank=AWSB&acct=1000123456789&amt=800.00&ref=2P-1");
  });

  it("same bank: the app's own transfer screen, not the other-bank one", () => {
    expect(resolveAppLink(cfg, "Dashen Bank", "android", vars, "internal")).toBe("dashen://own?to=1000123456789&amt=800.00");
  });

  it("a merchant wallet: the wallet screen", () => {
    expect(resolveAppLink(cfg, "Dashen Bank", "ios", vars, "wallet")).toBe("dashen://wallet?to=1000123456789&amt=800.00");
  });

  it("when the bank code is not configured, the other-bank link is skipped and the general link is used instead", () => {
    const noCode = { ...vars, bank_code: null };
    expect(resolveAppLink(cfg, "Dashen Bank", "android", noCode, "interbank")).toBe(`https://dashen.example/pay?u=${encodeURIComponent(vars.url)}`);
  });

  it("an Android intent link is never used on an iPhone", () => {
    const onlyIntent = JSON.stringify({ X: { interbank: { any: "intent://a#Intent;scheme=x;end" } } });
    expect(resolveAppLink(onlyIntent, "X", "ios", vars, "interbank")).toBeUndefined();
  });

  it("fills {account}/{bank}/{name} URL-encoded, and reads EthSwitch bank codes only from configuration", () => {
    expect(fillTemplate("x://p?a={account}&n={name}&b={bank}", { ...vars, name: "A & B Cafe" })).toBe("x://p?a=1000123456789&n=A%20%26%20B%20Cafe&b=Awash%20Bank");
    expect(bankCodeFor("Awash Bank", JSON.stringify({ "Awash Bank": "AWSB" }))).toBe("AWSB");
    expect(bankCodeFor("Awash Bank", undefined)).toBeNull(); // nothing is built in: the codes come from EthSwitch
    expect(bankCodeFor("Awash Bank", "not json")).toBeNull();
  });
});
