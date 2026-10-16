import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { publicBaseUrl } from "@/lib/rails";
import { rateLimit } from "@/lib/ratelimit";
import { sha256 } from "@/lib/ride";
import type { StoredAccount } from "@/lib/fieldcrypt";

/** Shared pieces of the ride-hailing routes: partner authentication, links and what may be shown. */

export const bad = (error: string, status = 400, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status, headers: { "Cache-Control": "no-store" } });

export interface Partner {
  id: string;
  name: string;
  merchant_id: string;
  /** An admin has allowed this company to send drivers' accounts itself (otherwise the drivers' own 2Pay accounts are used). */
  allow_partner_accounts: boolean;
}

const KEY_RE = /^2pay_rk_[A-Za-z0-9_-]{43}$/;

/** Authenticate a partner's server by its API key (`Authorization: Bearer 2pay_rk_...`). Only the key's hash is stored. */
export async function authPartner(admin: SupabaseClient, req: Request): Promise<{ ok: true; partner: Partner } | { ok: false; res: NextResponse }> {
  const key = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!KEY_RE.test(key)) return { ok: false, res: bad("A valid partner API key is required", 401) };
  const { data } = await admin.from("ride_partners").select("id, name, merchant_id, active, allow_partner_accounts").eq("key_hash", sha256(key)).maybeSingle();
  if (!data || !data.active) return { ok: false, res: bad("A valid partner API key is required", 401) };
  if (!(await rateLimit(admin, `ride:partner:${data.id}`, 600, 60))) return { ok: false, res: bad("Too many requests. Slow down.", 429) };
  void admin.from("ride_partners").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then(() => {}, () => {});
  return { ok: true, partner: { id: data.id, name: data.name, merchant_id: data.merchant_id, allow_partner_accounts: !!data.allow_partner_accounts } };
}

/** The public address used in the links given to a driver's phone. */
export function baseUrlFor(req: Request): string {
  try {
    return publicBaseUrl();
  } catch {
    return new URL(req.url).origin;
  }
}

/** A sale row as a driver's phone or a partner may see it: never the rail's internals or the driver's stored accounts. */
export function safeTx(row: Record<string, unknown>) {
  const { rail_checkout_url, rail_session_id, rail_nonce, payee_accounts, ...rest } = row;
  void rail_checkout_url, void rail_session_id, void rail_nonce, void payee_accounts;
  return rest;
}

export type RideStatus = "OPEN" | "PAID" | "CANCELLED" | "EXPIRED";
export const statusOf = (s: { status: string; expires_at: string }): RideStatus => (s.status === "OPEN" && new Date(s.expires_at).getTime() <= Date.now() ? "EXPIRED" : (s.status as RideStatus));

export const PAID_STATES = ["SUCCESS", "SETTLED"];

const SESSION_COLUMNS = "id, partner_id, partner_ride_id, driver_id, driver_merchant_id, accounts, amount, currency, status, expires_at, opened_at, ride_partners(name, merchant_id, active)";

function shape(data: Record<string, unknown> | null) {
  if (!data) return null;
  const rp = data.ride_partners as { name: string; merchant_id: string; active: boolean } | { name: string; merchant_id: string; active: boolean }[] | null;
  const partner = Array.isArray(rp) ? rp[0] : rp;
  if (!partner?.active) return null;
  return { ...(data as { id: string; partner_id: string; partner_ride_id: string; driver_id: string; driver_merchant_id: string | null; accounts: unknown; amount: number | string; currency: string; status: string; expires_at: string; opened_at: string | null }), partner };
}

/** The ride a checkout LINK names (the link is the credential: it is looked up by its hash). */
export async function sessionByToken(admin: SupabaseClient, token: unknown) {
  if (typeof token !== "string") return null;
  const { data } = await admin.from("ride_sessions").select(SESSION_COLUMNS).eq("token_hash", sha256(token)).maybeSingle();
  return shape(data as Record<string, unknown> | null);
}

/** A ride by its id, for the DRIVER it belongs to when they are signed in to 2Pay (so the app can open it without a link). */
export async function sessionForDriver(admin: SupabaseClient, rideId: unknown, driverMerchantId: string) {
  if (typeof rideId !== "string") return null;
  const { data } = await admin.from("ride_sessions").select(SESSION_COLUMNS).eq("id", rideId).eq("driver_merchant_id", driverMerchantId).maybeSingle();
  return shape(data as Record<string, unknown> | null);
}

/** The driver''s own accounts (as stored, encrypted), banks and wallets together, ready to be the payee of a ride. */
export async function driverStoredAccounts(admin: SupabaseClient, driverMerchantId: string): Promise<{ ok: true; accounts: StoredAccount[] } | { ok: false; code: string; error: string }> {
  const { data } = await admin.from("merchants").select("kind, saved_banks, saved_wallets").eq("id", driverMerchantId).maybeSingle();
  if (!data || data.kind !== "DRIVER") return { ok: false, code: "DRIVER_NOT_FOUND", error: "This driver has no 2Pay account." };
  const accounts = [...((data.saved_banks as StoredAccount[] | null) ?? []), ...((data.saved_wallets as StoredAccount[] | null) ?? [])];
  if (!accounts.length) return { ok: false, code: "DRIVER_NO_ACCOUNTS", error: "This driver has not added a bank or wallet to receive money yet." };
  return { ok: true, accounts };
}

/** Is this driver still linked (and active) with this company? Checked again when the pay node is made, so unlinking takes effect at once. */
export async function linkIsActive(admin: SupabaseClient, partnerId: string, driverRef: string, driverMerchantId: string): Promise<boolean> {
  const { data } = await admin.from("ride_driver_links").select("status, merchant_id").eq("partner_id", partnerId).eq("driver_ref", driverRef).maybeSingle();
  return !!data && data.status === "ACTIVE" && data.merchant_id === driverMerchantId;
}
/** What a partner sees about one of its rides: its state and, once paid, the fee breakdown recorded in the ledger. */
export async function viewSession(admin: SupabaseClient, sessionId: string) {
  const { data: s } = await admin.from("ride_sessions").select("id, partner_ride_id, driver_id, amount, currency, status, expires_at, created_at, paid_at").eq("id", sessionId).maybeSingle();
  if (!s) return null;
  const { data: txs } = await admin
    .from("transactions")
    .select("id, status, rail, base_fee, vat_fee, fee_ft, net_merchant_settlement, tip_amount, settled_at, created_at")
    .eq("ride_session_id", sessionId)
    .order("created_at", { ascending: false });
  const paid = (txs ?? []).find((t) => PAID_STATES.includes(t.status as string));
  const status = paid ? "PAID" : statusOf(s);
  return {
    session_id: s.id,
    partner_ride_id: s.partner_ride_id,
    driver_id: s.driver_id,
    status,
    fare: { amount: Number(s.amount), currency: s.currency },
    expires_at: s.expires_at,
    payment: paid
      ? { transaction_id: paid.id, paid_via: paid.rail, settled_at: paid.settled_at ?? s.paid_at, tip_amount: Number(paid.tip_amount ?? 0), base_fee: paid.base_fee == null ? null : Number(paid.base_fee), vat_fee: paid.vat_fee == null ? null : Number(paid.vat_fee), total_fee: Number(paid.fee_ft), net_driver_settlement: paid.net_merchant_settlement == null ? null : Number(paid.net_merchant_settlement) }
      : null,
  };
}