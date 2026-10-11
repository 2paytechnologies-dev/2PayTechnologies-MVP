/**
 * Signed session cookie. Uses Web Crypto only, so it runs in both the Edge middleware and Node route handlers.
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload)).
 */
export const SESSION_COOKIE = "2pay_session";
export const SESSION_TTL_S = 7 * 24 * 3600;

export interface SessionPayload {
  /** merchant id */ mid: string;
  /** verified phone, +251… */ ph: string;
  /** expiry, unix seconds */ exp: number;
}

const enc = new TextEncoder();

const b64url = (bytes: ArrayBuffer | Uint8Array) => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromB64url = (s: string): Uint8Array => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const key = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await key(secret, "sign"), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

/** Returns the payload only if the signature is valid (constant-time) and the session has not expired. */
export async function verifySession(token: string | undefined, secret: string | undefined): Promise<SessionPayload | null> {
  if (!token || !secret) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await key(secret, "verify"), fromB64url(sig) as BufferSource, enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as SessionPayload;
    if (typeof payload.mid !== "string" || typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
