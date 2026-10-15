import { createHash, randomBytes, randomUUID } from "node:crypto";
import { BANKS, WALLETS, isBank } from "@/lib/constants";
import { normalizeAccount, type SavedAccount } from "@/lib/settlement";

/**
 * Ride-hailing integration, pure parts (unit tested): turning a partner's request into a validated checkout intent, keys and
 * links, and choosing which of the driver's accounts a passenger's app should pay.
 */

/** Rail codes a partner may send, mapped to the institution names 2Pay uses. Exact institution names are accepted too. */
const RAIL_ALIASES: Record<string, string> = {
  TELEBIRR: "Telebirr",
  CBE_BIRR: "CBE Birr",
  CBEBIRR: "CBE Birr",
  CBE_CONNECT: "CBE Connect",
  CBE: "Commercial Bank of Ethiopia (CBE)",
  AWASH: "Awash Bank",
  AWASH_BANK: "Awash Bank",
  AWASH_BIRR: "AwashBirr",
  AWASHBIRR: "AwashBirr",
  DASHEN: "Dashen Bank",
  DASHEN_BANK: "Dashen Bank",
  AMOLE: "Amole",
  MPESA: "M-Pesa",
  M_PESA: "M-Pesa",
  HELLOCASH: "HelloCash",
  KACHA: "Kacha",
  YAYA: "YaYa Wallet",
  YAYA_WALLET: "YaYa Wallet",
  BOA: "Bank of Abyssinia",
  BANK_OF_ABYSSINIA: "Bank of Abyssinia",
  WEGAGEN: "Wegagen Bank",
  NIB: "Nib International Bank",
  COOP: "Cooperative Bank of Oromia",
  COOP_BANK: "Cooperative Bank of Oromia",
  ABAY: "Abay Bank",
  ZEMEN: "Zemen Bank",
  HIBRET: "Hibret Bank",
  ENAT: "Enat Bank",
  BUNNA: "Bunna International Bank",
  AHADU: "Ahadu Bank",
  AMHARA: "Amhara Bank",
};

const code = (s: string) => s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const KNOWN = new Map<string, string>([...[...BANKS, ...WALLETS].map((n) => [code(n), n] as [string, string]), ...Object.entries(RAIL_ALIASES)]);

/** The 2Pay institution for a partner's rail code, or null if it is not a known national bank or wallet. */
export function railToInstitution(rail: unknown): string | null {
  return typeof rail === "string" ? (KNOWN.get(code(rail)) ?? null) : null;
}

export const MAX_DRIVER_ACCOUNTS = 4;

export type Built<T> = { ok: true; value: T } | { ok: false; error: string };

/** The driver's payout accounts as sent by the partner: validated like a merchant's own, at most four, no duplicates. */
export function buildDriverAccounts(raw: unknown): Built<SavedAccount[]> {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "driver_wallet_accounts must be a list with at least one account" };
  if (raw.length > MAX_DRIVER_ACCOUNTS) return { ok: false, error: `driver_wallet_accounts can hold at most ${MAX_DRIVER_ACCOUNTS} accounts` };
  const seen = new Set<string>();
  const out: SavedAccount[] = [];
  for (const [i, e] of (raw as { rail?: unknown; account_number?: unknown }[]).entries()) {
    const institution = railToInstitution(e?.rail);
    if (!institution) return { ok: false, error: `driver_wallet_accounts[${i}].rail is not a known bank or wallet` };
    const number = normalizeAccount(isBank(institution) ? "bank" : "wallet", e?.account_number);
    if (!number) return { ok: false, error: `driver_wallet_accounts[${i}].account_number is not valid for ${institution}` };
    const key = `${institution}|${number}`;
    if (seen.has(key)) return { ok: false, error: `driver_wallet_accounts[${i}] is a duplicate` };
    seen.add(key);
    out.push({ id: randomUUID(), institution, account_number: number });
  }
  return { ok: true, value: out };
}

const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
export const MAX_FARE = 1_000_000;

export interface RideIntent {
  partnerRideId: string;
  driverId: string;
  accounts: SavedAccount[];
  fare: number;
}

/** Validate a partner's checkout intent. The fare must be a positive ETB amount with at most two decimals. */
export function parseRideIntent(body: unknown): Built<RideIntent> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.partner_ride_id !== "string" || !ID_RE.test(b.partner_ride_id)) return { ok: false, error: "partner_ride_id is required (letters, digits . _ : - , up to 64)" };
  if (typeof b.driver_id !== "string" || !ID_RE.test(b.driver_id)) return { ok: false, error: "driver_id is required (letters, digits . _ : - , up to 64)" };
  if (b.currency !== undefined && b.currency !== "ETB") return { ok: false, error: "currency must be ETB" };
  const fare = b.fare_amount;
  if (typeof fare !== "number" || !Number.isFinite(fare) || fare <= 0 || fare > MAX_FARE) return { ok: false, error: `fare_amount must be a number between 0 and ${MAX_FARE}` };
  if (Math.abs(Math.round(fare * 100) - fare * 100) > 1e-6) return { ok: false, error: "fare_amount can have at most 2 decimals" };
  const accounts = buildDriverAccounts(b.driver_wallet_accounts);
  if (!accounts.ok) return accounts;
  return { ok: true, value: { partnerRideId: b.partner_ride_id, driverId: b.driver_id, accounts: accounts.value, fare: Math.round(fare * 100) / 100 } };
}

// ------------------------------------------------------------------ keys and links
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A partner API key (shown once) and its hash and hint (kept). */
export function newApiKey() {
  const key = `2pay_rk_${randomBytes(32).toString("base64url")}`;
  return { key, hash: sha256(key), hint: key.slice(-4) };
}

/** The secret in the link given to the driver's phone: 256 bits, kept only as a hash. */
export function newSessionToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256(token) };
}
export { SESSION_TOKEN_RE } from "@/lib/ride-token";

export function sessionLinks(baseUrl: string, token: string) {
  const terminal_url = `${baseUrl}/terminal?session_token=${token}`;
  return {
    terminal_url,
    deep_link: `twopay://checkout?token=${token}`,
    // Opens the 2Pay app if it is installed; otherwise the browser goes to the terminal page.
    android_intent: `intent://checkout?token=${token}#Intent;scheme=twopay;package=com.twopay.merchant;S.browser_fallback_url=${encodeURIComponent(terminal_url)};end`,
  };
}

// ------------------------------------------------------------------ choosing the driver's account
const FAMILY: Record<string, string> = { "CBE Birr": "Commercial Bank of Ethiopia (CBE)", "CBE Connect": "Commercial Bank of Ethiopia (CBE)", AwashBirr: "Awash Bank" };
const familyOf = (n: string) => FAMILY[n] ?? n;

/**
 * Which of the driver's accounts should receive a payment from this passenger app?
 *  1. The account the passenger tapped, if they chose one themselves (`accountId`).
 *  2. Same institution or bank family: an internal transfer, fastest and usually free.
 *  3. Same kind (a wallet passenger pays a wallet, a bank passenger a bank).
 *  4. The first account the driver listed.
 */
export function chooseDriverAccount<T extends { id: string; institution: string }>(app: { name: string; kind: "bank" | "wallet" } | null, accounts: T[], accountId?: string | null): T | null {
  if (!accounts.length) return null;
  if (accountId) {
    const picked = accounts.find((a) => a.id === accountId);
    if (picked) return picked;
  }
  if (app) {
    const same = accounts.find((a) => familyOf(a.institution) === familyOf(app.name));
    if (same) return same;
    const kind = accounts.find((a) => (isBank(a.institution) ? "bank" : "wallet") === app.kind);
    if (kind) return kind;
  }
  return accounts[0];
}

export const kindOfInstitution = (name: string): "bank" | "wallet" => (isBank(name) ? "bank" : "wallet");
