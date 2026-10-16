import type { SupabaseClient } from "@supabase/supabase-js";
import { priceTransaction } from "@/lib/pricing/engine";
import { toMasked, type SavedAccount } from "@/lib/settlement";
import { railMode } from "@/lib/rails";
import { openAccount, openAccounts, type StoredAccount } from "@/lib/fieldcrypt";
import { faydaRequired } from "@/lib/fayda-ekyc";
import { emitAiEvent } from "@/lib/ai-events";
import { BANKS } from "@/lib/constants";

/** Postgres 42703 (undefined column) / PostgREST PGRST204 (column missing from schema cache): a migration has not been applied. */
const isSchemaDrift = (e: { code?: string; message?: string }) => e.code === "42703" || e.code === "PGRST204" || /schema cache/i.test(e.message ?? "");

export type NodeResult =
  | { ok: true; tx: Record<string, unknown> }
  | { ok: false; status: number; body: { error: string; code?: string } };

/** Pay nodes live for 90 seconds; the terminal's QR rotates well inside that. */
export const NODE_TTL_MS = 90_000;

/** A ride-hailing sale pays the DRIVER's accounts (given by the partner for this one ride), not the partner business's own. */
export interface Payee {
  rideSessionId: string;
  /** Stored (encrypted) accounts, as kept on the ride session. */
  accounts: StoredAccount[];
}

/**
 * Create a single-use PENDING pay node for a merchant. The one place that does this, so the cashier terminal, the
 * static shop QR and the ride-hailing terminal obey the same rules: routing snapshot (masked), the tiered fee with VAT,
 * verification gate in live mode. A sale keyed by a waiter or cashier carries their id, so every payment can be traced
 * to the person who took it.
 */
export async function createPayNode(
  admin: SupabaseClient,
  merchantId: string,
  amount: number,
  source: "TERMINAL" | "STATIC_QR" | "RIDE",
  /** The team member keying the sale (from their session, never from a request). null = the owner or the counter. */
  staffId: string | null = null,
  /** Ride-hailing only: where this ride's money goes. */
  payee: Payee | null = null,
): Promise<NodeResult> {
  const rounded = Math.round(amount * 100) / 100;
  // The fee schedule (base + 15% VAT on the base) is fixed by the amount. A payment too small to cover its own fee is refused.
  const price = priceTransaction(rounded);
  if (price.net_merchant_settlement <= 0) {
    return { ok: false, status: 400, body: { error: "That amount is too small to process.", code: "AMOUNT_TOO_SMALL" } };
  }

  const { data: merchant, error: mErr } = await admin
    .from("merchants")
    .select("id, kind, active_bank, active_wallet, kyc_status, static_qr_enabled, fayda_verified_at, fayda_verified")
    .eq("id", merchantId)
    .maybeSingle();
  if (mErr) {
    console.error("[pay-nodes] merchant lookup:", mErr.code, mErr.message);
    if (isSchemaDrift(mErr)) {
      return { ok: false, status: 500, body: { error: "The database is out of date. Run the latest migrations in supabase/, then try again.", code: "SCHEMA_OUT_OF_DATE" } };
    }
    return { ok: false, status: 500, body: { error: "Could not load merchant" } };
  }
  if (!merchant) return { ok: false, status: 404, body: { error: "Unknown merchant" } };

  if (source === "STATIC_QR" && merchant.static_qr_enabled === false) {
    return { ok: false, status: 403, body: { error: "This shop is not accepting scan-to-pay payments right now", code: "STATIC_QR_DISABLED" } };
  }

  // An individual driver (kind DRIVER) is not a business: no TIN or licence is asked of them, and the national ID (Fayda) check is not
  // required of them. They are known by their verified phone and by the ride-hailing companies that link them.
  const individual = merchant.kind === "DRIVER";
  // With real money, only verified businesses may take payments (when the operator turns the gate on).
  if (railMode() === "live" && process.env.KYC_REQUIRED_FOR_LIVE === "true" && !individual && merchant.kyc_status !== "VERIFIED") {
    return { ok: false, status: 403, body: { error: "Business verification is required before taking live payments.", code: "KYC_REQUIRED" } };
  }

  // With real money the owner's national ID (Fayda) must also be verified (unless KYC_REQUIRE_FAYDA=false). A ride-hailing company
  // has no merchant owner who signs in: an admin registers it after checking its documents, and its drivers are paid directly.
  if (faydaRequired() && merchant.kind !== "RIDE_PARTNER" && !individual && !merchant.fayda_verified && !merchant.fayda_verified_at) {
    return { ok: false, status: 403, body: { error: "The owner must verify their national ID (Fayda) before taking live payments.", code: "FAYDA_REQUIRED" } };
  }

  // Account numbers are stored encrypted; open them here (server side) only to make the masked snapshot.
  let bank: SavedAccount | null;
  let wallet: SavedAccount | null;
  if (payee) {
    // A ride: the driver's first bank and first wallet are the defaults shown; the payer's own app picks among all of them later.
    const pool = openAccounts(payee.accounts);
    if (pool.length !== payee.accounts.length) return { ok: false, status: 503, body: { error: "The payment account cannot be read right now. Contact 2Pay support.", code: "ACCOUNT_UNREADABLE" } };
    bank = pool.find((a) => (BANKS as readonly string[]).includes(a.institution)) ?? null;
    wallet = pool.find((a) => !(BANKS as readonly string[]).includes(a.institution)) ?? null;
  } else {
    bank = openAccount(merchant.active_bank);
    wallet = openAccount(merchant.active_wallet);
    if ((merchant.active_bank && !bank) || (merchant.active_wallet && !wallet)) {
      return { ok: false, status: 503, body: { error: "The payment account cannot be read right now. Contact 2Pay support.", code: "ACCOUNT_UNREADABLE" } };
    }
  }
  if (!bank && !wallet) {
    return { ok: false, status: 409, body: { error: "No settlement account configured. Add and activate a bank or wallet first.", code: "NO_ACTIVE_ROUTING" } };
  }

  const { data, error } = await admin
    .from("transactions")
    .insert({
      merchant_id: merchantId,
      amount: rounded,
      expected_amount: rounded,
      // The ledger records exactly what 2Pay charges: the fee before VAT, the VAT on it, and what the merchant is paid.
      // fee_ft keeps the total (base + VAT) so existing totals and reports keep working.
      fee_ft: price.total_fee,
      base_fee: price.base_fee,
      vat_fee: price.vat_fee,
      net_merchant_settlement: price.net_merchant_settlement,
      expires_at: new Date(Date.now() + NODE_TTL_MS).toISOString(),
      routed_bank: bank ? toMasked(bank) : null,
      routed_wallet: wallet ? toMasked(wallet) : null,
      source,
      ...(staffId ? { staff_id: staffId } : {}),
      ...(payee ? { payee_accounts: payee.accounts, ride_session_id: payee.rideSessionId } : {}),
    })
    .select()
    .single();

  if (error) {
    console.error("[pay-nodes] insert:", error.code, error.message);
    if (isSchemaDrift(error)) {
      return { ok: false, status: 500, body: { error: "The database is out of date. Run the latest migrations in supabase/, then try again.", code: "SCHEMA_OUT_OF_DATE" } };
    }
    return { ok: false, status: 500, body: { error: "Could not create pay node" } };
  }
  emitAiEvent(admin, "CREATED", data as never); // for the AI layer, pseudonymised, after the response; a no-op unless it is switched on
  // The driver's stored accounts stay on the server: they are never part of what a terminal or browser receives.
  const { payee_accounts: _hidden, ...safe } = data as Record<string, unknown>;
  void _hidden;
  return { ok: true, tx: safe };
}