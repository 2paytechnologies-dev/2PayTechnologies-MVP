import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionPayload } from "@/lib/session";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

/**
 * The security key: the second lock on the settlement vault. A 6-digit key, chosen by the owner (and by each manager they
 * appoint), checked together with a one-time code sent to that person's own phone before any receiving account is added,
 * edited or removed. Pure rules here (unit tested); the routes wire them to the database.
 */

export const PIN_RE = /^\d{6}$/;
/** Digit patterns that are guessed first: refused when the key is chosen. */
const WEAK = new Set(["000000", "111111", "222222", "333333", "444444", "555555", "666666", "777777", "888888", "999999", "123456", "654321", "012345", "123123", "121212", "112233", "696969"]);
export const isWeakPin = (pin: string) => WEAK.has(pin);

export const MAX_FAILED = 5;
export const LOCK_MINUTES = 15;

// scrypt, per OWASP's guidance: memory-hard, so a stolen hash cannot be brute-forced cheaply. 6 digits is a small space, which
// is why the key is never used alone: it needs the one-time code too, it locks after five wrong tries, and it is rate limited.
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pin, salt, 32, PARAMS);
  return `scrypt$${PARAMS.N}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPin(pin: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored || !PIN_RE.test(pin)) return false;
  const [kind, n, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || Number(n) !== PARAMS.N || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64url");
  const got = await scrypt(pin, Buffer.from(salt, "base64url"), want.length, PARAMS);
  return want.length === got.length && timingSafeEqual(want, got);
}

export interface LockState {
  failed: number;
  lockedUntil: string | null;
}

export const isLocked = (s: LockState, now = Date.now()) => !!s.lockedUntil && new Date(s.lockedUntil).getTime() > now;
export const minutesLeft = (s: LockState, now = Date.now()) => Math.max(1, Math.ceil((new Date(s.lockedUntil ?? 0).getTime() - now) / 60_000));

/** After a wrong key: count it, and lock for 15 minutes on the fifth. */
export function afterWrongPin(s: LockState, now = Date.now()): LockState {
  const failed = s.failed + 1;
  return failed >= MAX_FAILED ? { failed: 0, lockedUntil: new Date(now + LOCK_MINUTES * 60_000).toISOString() } : { failed, lockedUntil: null };
}

// ------------------------------------------------------------------ who approves
export interface Approver {
  /** OWNER (the business's own phone) or MANAGER (an appointed team member). */
  kind: "OWNER" | "MANAGER";
  id: string;
  table: "merchants" | "merchant_staff";
  phone: string | null;
  hasPin: boolean;
  lock: LockState;
}

/**
 * Who is allowed to approve a change to the receiving accounts, and whose phone gets the code. A signed-in manager
 * approves as themselves. Otherwise it is the business owner (their registered phone): that includes the open test mode,
 * where there is no session, so even then a change needs the owner's key and the owner's code, never just the page.
 * Returns null for anyone who may not approve at all (cashiers, waiters).
 */
export async function resolveApprover(admin: SupabaseClient, merchantId: string, session: SessionPayload | null): Promise<Approver | null> {
  const role = session?.rl ?? "OWNER";
  if (role === "MANAGER") {
    if (!session?.sid) return null;
    const { data } = await admin.from("merchant_staff").select("id, phone, role, active, vault_pin_hash, vault_failed, vault_locked_until").eq("id", session.sid).eq("merchant_id", merchantId).maybeSingle();
    if (!data || !data.active || data.role !== "MANAGER") return null;
    return { kind: "MANAGER", id: data.id, table: "merchant_staff", phone: data.phone, hasPin: !!data.vault_pin_hash, lock: { failed: data.vault_failed ?? 0, lockedUntil: data.vault_locked_until ?? null } };
  }
  if (role !== "OWNER") return null;
  const { data } = await admin.from("merchants").select("id, phone, vault_pin_hash, vault_failed, vault_locked_until").eq("id", merchantId).maybeSingle();
  if (!data) return null;
  return { kind: "OWNER", id: data.id, table: "merchants", phone: data.phone ?? null, hasPin: !!data.vault_pin_hash, lock: { failed: data.vault_failed ?? 0, lockedUntil: data.vault_locked_until ?? null } };
}

export const maskPhone = (p: string) => `${p.slice(0, 7)}•••${p.slice(-2)}`;