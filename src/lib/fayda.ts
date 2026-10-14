import { createHash, createHmac, createPrivateKey, createPublicKey, createSign, createVerify, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Fayda (Ethiopia's national digital ID) sign-in for KYC: "prove who the owner really is".
 *
 * It is a standard OpenID Connect authorization-code flow with PKCE, with the relying party authenticating by a signed
 * assertion (private_key_jwt, RS256), which is how Fayda's eSignet service works. EVERYTHING that identifies the
 * deployment comes from configuration, not from code, because the client id, the registered key and the endpoints are
 * issued by the National ID Program when a relying party is onboarded:
 *
 *   FAYDA_ISSUER        the OpenID issuer URL (its /.well-known/openid-configuration gives every other endpoint)
 *   FAYDA_CLIENT_ID     the client id the National ID Program issued to 2Pay
 *   FAYDA_PRIVATE_JWK   the private key (JWK, RSA) whose PUBLIC half is registered with them; never leaves the server
 *   FAYDA_REDIRECT_URI  optional; defaults to <PUBLIC_BASE_URL>/api/fayda/callback (must be the registered one)
 *   FAYDA_SCOPES        optional; default "openid profile"
 *   FAYDA_ACR_VALUES    optional; the assurance level to ask for
 *
 * Until those are set, nothing here runs and the app says so. What we keep from a successful check is minimal: that it
 * happened, a keyed hash of the person's national-ID subject, and their name (encrypted). Not the ID number, photo or birth date.
 */

export interface FaydaConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  acr?: string;
  privateJwk: JsonWebKey & { kid?: string };
}

export function faydaConfig(): FaydaConfig | null {
  const issuer = (process.env.FAYDA_ISSUER ?? "").replace(/\/+$/, "");
  const clientId = process.env.FAYDA_CLIENT_ID ?? "";
  const rawKey = process.env.FAYDA_PRIVATE_JWK ?? "";
  if (!issuer || !clientId || !rawKey) return null;
  let privateJwk: FaydaConfig["privateJwk"];
  try {
    privateJwk = JSON.parse(rawKey);
    if (privateJwk.kty !== "RSA" || !privateJwk.d) return null;
  } catch {
    return null;
  }
  const u = safeUrl(issuer);
  if (!u || !isAllowedScheme(u)) return null;
  const base = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  const redirectUri = process.env.FAYDA_REDIRECT_URI || (base ? `${base}/api/fayda/callback` : "");
  if (!redirectUri) return null;
  return { issuer, clientId, redirectUri, scopes: process.env.FAYDA_SCOPES || "openid profile", acr: process.env.FAYDA_ACR_VALUES || undefined, privateJwk };
}
export const faydaConfigured = () => !!faydaConfig();

const safeUrl = (s: string) => {
  try {
    return new URL(s);
  } catch {
    return null;
  }
};
/** https only; plain http is accepted for a local test identity provider on this machine and nothing else. */
const isAllowedScheme = (u: URL) => u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && process.env.FAYDA_ALLOW_INSECURE === "true");

// ------------------------------------------------------------------ tiny JWT toolkit (RS256 only; "none" and HMAC are refused)
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const fromB64u = (s: string) => Buffer.from(s, "base64url");

export function signJwtRs256(payload: Record<string, unknown>, jwk: FaydaConfig["privateJwk"]): string {
  const header = { alg: "RS256", typ: "JWT", ...(jwk.kid ? { kid: jwk.kid } : {}) };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig = createSign("RSA-SHA256").update(input).sign(createPrivateKey({ key: jwk as never, format: "jwk" }));
  return `${input}.${b64u(sig)}`;
}

export interface Jwks {
  keys: (JsonWebKey & { kid?: string; use?: string; alg?: string })[];
}

/** Verify an RS256 JWT against the issuer's keys. Returns the claims, or throws. Checks iss, aud, exp (and nonce when given). */
export function verifyJwtRs256(token: string, jwks: Jwks, expect: { iss: string; aud: string; nonce?: string }, now = Date.now()): Record<string, unknown> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new Error("malformed token");
  const header = JSON.parse(fromB64u(h).toString()) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") throw new Error(`unsupported token algorithm ${header.alg ?? "none"}`);
  const candidates = jwks.keys.filter((k) => k.kty === "RSA" && (!header.kid || k.kid === header.kid) && (!k.use || k.use === "sig"));
  const ok = candidates.some((k) => createVerify("RSA-SHA256").update(`${h}.${p}`).verify(createPublicKey({ key: k as never, format: "jwk" }), fromB64u(s)));
  if (!ok) throw new Error("bad token signature");
  const c = JSON.parse(fromB64u(p).toString()) as Record<string, unknown>;
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (c.iss !== expect.iss) throw new Error("wrong issuer");
  if (!aud.includes(expect.aud)) throw new Error("wrong audience");
  if (typeof c.exp !== "number" || c.exp * 1000 <= now - 60_000) throw new Error("token expired");
  if (expect.nonce !== undefined && c.nonce !== expect.nonce) throw new Error("wrong nonce");
  return c;
}

// ------------------------------------------------------------------ discovery and the OpenID steps
export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
}

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, load: () => Promise<T>, ttlMs = 3_600_000): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}
const getJson = async (url: string, init?: RequestInit) => {
  const u = safeUrl(url);
  if (!u || !isAllowedScheme(u)) throw new Error("identity provider endpoint must be https");
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!res.ok) throw new Error(`identity provider answered ${res.status}`);
  return res;
};

export const discover = (cfg: FaydaConfig) =>
  cached<Discovery>(`disc:${cfg.issuer}`, async () => {
    const d = (await (await getJson(`${cfg.issuer}/.well-known/openid-configuration`)).json()) as Discovery;
    if (d.issuer !== cfg.issuer) throw new Error("issuer mismatch in discovery");
    for (const k of ["authorization_endpoint", "token_endpoint", "userinfo_endpoint", "jwks_uri"] as const) {
      const u = safeUrl(d[k]);
      if (!u || !isAllowedScheme(u)) throw new Error(`discovery ${k} is not https`);
    }
    return d;
  });

const loadJwks = (d: Discovery) => cached<Jwks>(`jwks:${d.jwks_uri}`, async () => (await (await getJson(d.jwks_uri)).json()) as Jwks, 600_000);

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function buildAuthorizeUrl(cfg: FaydaConfig, d: Discovery, p: { state: string; nonce: string; challenge: string; lang: "en" | "am" }): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes,
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    ui_locales: p.lang === "am" ? "am" : "en",
    ...(cfg.acr ? { acr_values: cfg.acr } : {}),
  });
  return `${d.authorization_endpoint}?${q}`;
}

/** Trade the code for tokens, proving who we are with a signed assertion (no shared secret ever leaves the server). */
export async function exchangeCode(cfg: FaydaConfig, d: Discovery, code: string, verifier: string): Promise<{ id_token: string; access_token: string }> {
  const assertion = signJwtRs256({ iss: cfg.clientId, sub: cfg.clientId, aud: d.token_endpoint, jti: randomUUID(), exp: Math.floor(Date.now() / 1000) + 120 }, cfg.privateJwk);
  const res = await getJson(d.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
      client_id: cfg.clientId,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
      code_verifier: verifier,
    }),
  });
  const t = (await res.json()) as { id_token?: string; access_token?: string };
  if (!t.id_token || !t.access_token) throw new Error("token response is missing a token");
  return { id_token: t.id_token, access_token: t.access_token };
}

export interface FaydaClaims {
  sub: string;
  name: string | null;
}

/** A claim may be a plain string, {value}, or a list of {language, value} (Fayda is multilingual): reduce it to one string. */
export function claimText(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (Array.isArray(v)) {
    const en = v.find((x) => x && typeof x === "object" && /^en/i.test(String((x as { language?: string }).language ?? "")));
    return claimText(en ?? v[0]);
  }
  if (v && typeof v === "object" && "value" in v) return claimText((v as { value: unknown }).value);
  return null;
}

/** Validate the ID token, then read the person's claims from the userinfo endpoint (signed or plain). */
export async function verifiedClaims(cfg: FaydaConfig, d: Discovery, tokens: { id_token: string; access_token: string }, nonce: string): Promise<FaydaClaims> {
  const jwks = await loadJwks(d);
  const idc = verifyJwtRs256(tokens.id_token, jwks, { iss: cfg.issuer, aud: cfg.clientId, nonce });
  const ui = await getJson(d.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json, application/jwt" } });
  const type = ui.headers.get("content-type") ?? "";
  const body = await ui.text();
  let claims: Record<string, unknown>;
  if (/jwt/i.test(type) || body.split(".").length === 3) {
    // a signed userinfo: verify it exactly like the ID token (an encrypted one needs a decryption key we do not hold)
    if (body.split(".").length === 5) throw new Error("userinfo is encrypted; configure the provider to sign it instead");
    claims = verifyJwtRs256(body.trim(), jwks, { iss: cfg.issuer, aud: cfg.clientId });
  } else {
    claims = JSON.parse(body) as Record<string, unknown>;
  }
  const sub = String(claims.sub ?? "");
  if (!sub || sub !== String(idc.sub)) throw new Error("userinfo does not belong to this sign-in");
  return { sub, name: claimText(claims.name) ?? claimText(claims.given_name) };
}

/** A keyed hash of the national-ID subject: the same person is recognisable, the number is never stored. */
export const subjectHash = (sub: string, secret: string) => createHmac("sha256", secret).update(`2pay:fayda:sub:${sub}`).digest("hex");

// ------------------------------------------------------------------ the short-lived "where were we" cookie
export const FAYDA_COOKIE = "2pay_fayda";
export const FAYDA_TTL_S = 600;

export interface FaydaState {
  state: string;
  nonce: string;
  verifier: string;
  /** who is verifying: the owner row or a manager row */
  mid: string;
  kind: "OWNER" | "MANAGER";
  id: string;
  exp: number;
}

const mac = (body: string, secret: string) => createHmac("sha256", secret).update(`2pay:fayda:state:${body}`).digest("base64url");

export function signState(s: FaydaState, secret: string): string {
  const body = b64u(JSON.stringify(s));
  return `${body}.${mac(body, secret)}`;
}

export function readState(token: string | undefined, secret: string | undefined, now = Date.now()): FaydaState | null {
  if (!token || !secret) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const want = Buffer.from(mac(body, secret));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const s = JSON.parse(fromB64u(body).toString()) as FaydaState;
    return s.exp * 1000 > now ? s : null;
  } catch {
    return null;
  }
}