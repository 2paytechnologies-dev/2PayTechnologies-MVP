import type { SupabaseClient } from "@supabase/supabase-js";
import { feeBreakdown } from "@/lib/fee";
import { toMasked, type SavedAccount } from "@/lib/settlement";
import { nodeFeeContext } from "@/lib/watchdog";
import { railMode } from "@/lib/rails";
import { openAccount } from "@/lib/fieldcrypt";

/** Postgres 42703 (undefined column) / PostgREST PGRST204 (column missing from schema cache): a migration has not been applied. */
const isSchemaDrift = (e: { code?: string; message?: string }) => e.code === "42703" || e.code === "PGRST204" || /schema cache/i.test(e.message ?? "");

export type NodeResult =
  | { ok: true; tx: Record<string, unknown> }
  | { ok: false; status: number; body: { error: string; code?: string } };

/** Pay nodes live for 90 seconds; the terminal's QR rotates well inside that. */
export const NODE_TTL_MS = 90_000;

/**
 * Create a single-use PENDING pay node for a merchant. The one place that does this, so the cashier terminal and the
 * static shop QR obey the same rules: routing snapshot (masked), node-priced fee, verification gate in live mode.
 * A sale keyed by a waiter or cashier carries their id, so every payment can be traced to the person who took it.
 */
export async function createPayNode(
  admin: SupabaseClient,
  merchantId: string,
  amount: number,
  source: "TERMINAL" | "STATIC_QR",
  /** The team member keying the sale (from their session, never from a request). null = the owner or the counter. */
  staffId: string | null = null,
): Promise<NodeResult> {
  const rounded = Math.round(amount * 100) / 100;

  const { data: merchant, error: mErr } = await admin
    .from("merchants")
    .select("id, active_bank, active_wallet, kyc_status, static_qr_enabled, fayda_verified_at")
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

  // With real money, only verified businesses may take payments (when the operator turns the gate on).
  if (railMode() === "live" && process.env.KYC_REQUIRED_FOR_LIVE === "true" && merchant.kyc_status !== "VERIFIED") {
    return { ok: false, status: 403, body: { error: "Business verification is required before taking live payments.", code: "KYC_REQUIRED" } };
  }

  // Account numbers are stored encrypted; open them here (server side) only to make the masked snapshot.
  // With KYC_REQUIRE_FAYDA=true the owner's national ID (Fayda) must also be verified before live payments are taken.
  if (railMode() === "live" && process.env.KYC_REQUIRE_FAYDA === "true" && !merchant.fayda_verified_at) {
    return { ok: false, status: 403, body: { error: "The owner must verify their national ID (Fayda) before taking live payments.", code: "FAYDA_REQUIRED" } };
  }

  const bank: SavedAccount | null = openAccount(merchant.active_bank);
  const wallet: SavedAccount | null = openAccount(merchant.active_wallet);
  if ((merchant.active_bank && !bank) || (merchant.active_wallet && !wallet)) {
    return { ok: false, status: 503, body: { error: "The payment account cannot be read right now. Contact 2Pay support.", code: "ACCOUNT_UNREADABLE" } };
  }
  if (!bank && !wallet) {
    return { ok: false, status: 409, body: { error: "No settlement account configured. Add and activate a bank or wallet first.", code: "NO_ACTIVE_ROUTING" } };
  }

  // F_t needs the node's risk/traffic/loyalty; a lookup failure prices the node neutrally.
  const ctx = await nodeFeeContext(admin, merchantId);
  const { fee } = feeBreakdown({ volume: rounded, ...ctx });

  const { data, error } = await admin
    .from("transactions")
    .insert({
      merchant_id: merchantId,
      amount: rounded,
      expected_amount: rounded,
      fee_ft: fee,
      expires_at: new Date(Date.now() + NODE_TTL_MS).toISOString(),
      routed_bank: bank ? toMasked(bank) : null,
      routed_wallet: wallet ? toMasked(wallet) : null,
      source,
      ...(staffId ? { staff_id: staffId } : {}),
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
  return { ok: true, tx: data };
}
