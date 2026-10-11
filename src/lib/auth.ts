import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_TTL_S, signSession } from "@/lib/session";
import { normalizeWalletNumber } from "@/lib/settlement";

/** Server-only auth helpers (Node runtime). */

/**
 * TEST PHASE: authentication is NOT enforced unless AUTH_ENFORCED=true. In test mode anyone with the link can
 * open the terminal and every dashboard, and OTP codes are returned in the API response (no SMS provider yet).
 */
export const authEnforced = () => process.env.AUTH_ENFORCED === "true";
export const testMode = () => !authEnforced();

export const OTP_TTL_S = 300;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_REQUESTS = 3; // per phone per OTP_REQUEST_WINDOW_S
export const OTP_REQUEST_WINDOW_S = 600;

/** HMAC key for session cookies and OTP hashes. Must be at least 32 characters. */
export function sessionSecret(): string | null {
  const s = process.env.SESSION_SECRET;
  return s && s.length >= 32 ? s : null;
}

/** Ethiopian mobile numbers only, normalised to +251XXXXXXXXX. */
export const normalizePhone = (raw: unknown) => normalizeWalletNumber(raw);

export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

/** Keyed hash bound to the challenge, so a stolen hash is useless for any other challenge or phone. */
export const hashCode = (secret: string, challengeId: string, phone: string, code: string) =>
  createHmac("sha256", secret).update(`${challengeId}:${phone}:${code}`).digest("hex");

export function codeMatches(expectedHex: string, actualHex: string): boolean {
  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(actualHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function attachSession(res: NextResponse, merchantId: string, phone: string, secret: string) {
  const token = await signSession({ mid: merchantId, ph: phone, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S }, secret);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_S,
  });
}

/** Only same-site relative paths are valid post-login destinations (blocks open redirects). */
export const safeNext = (next: unknown, fallback = "/dashboard/merchant") =>
  typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : fallback;
