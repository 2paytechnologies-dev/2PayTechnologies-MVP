import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { publicBaseUrl } from "@/lib/rails";
import { rateLimit } from "@/lib/ratelimit";
import { sha256 } from "@/lib/ride";

/** Shared pieces of the ride-hailing routes: partner authentication, links and what may be shown. */

export const bad = (error: string, status = 400, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status, headers: { "Cache-Control": "no-store" } });

export interface Partner {
  id: string;
  name: string;
  merchant_id: string;
}

const KEY_RE = /^2pay_rk_[A-Za-z0-9_-]{43}$/;

/** Authenticate a partner's server by its API key (`Authorization: Bearer 2pay_rk_...`). Only the key's hash is stored. */
export async function authPartner(admin: SupabaseClient, req: Request): Promise<{ ok: true; partner: Partner } | { ok: false; res: NextResponse }> {
  const key = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!KEY_RE.test(key)) return { ok: false, res: bad("A valid partner API key is required", 401) };
  const { data } = await admin.from("ride_partners").select("id, name, merchant_id, active").eq("key_hash", sha256(key)).maybeSingle();
  if (!data || !data.active) return { ok: false, res: bad("A valid partner API key is required", 401) };
  if (!(await rateLimit(admin, `ride:partner:${data.id}`, 600, 60))) return { ok: false, res: bad("Too many requests. Slow down.", 429) };
  void admin.from("ride_partners").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then(() => {}, () => {});
  return { ok: true, partner: { id: data.id, name: data.name, merchant_id: data.merchant_id } };
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

export async function sessionByToken(admin: SupabaseClient, token: unknown) {
  if (typeof token !== "string") return null;
  const { data } = await admin
    .from("ride_sessions")
    .select("id, partner_id, partner_ride_id, driver_id, accounts, amount, currency, status, expires_at, opened_at, ride_partners(name, merchant_id, active)")
    .eq("token_hash", sha256(token))
    .maybeSingle();
  if (!data) return null;
  const partner = Array.isArray(data.ride_partners) ? data.ride_partners[0] : data.ride_partners;
  if (!partner?.active) return null;
  return { ...data, partner: partner as { name: string; merchant_id: string; active: boolean } };
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