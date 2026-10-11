import type { SupabaseClient } from "@supabase/supabase-js";
import { checkAml, checkVelocity } from "@/lib/watchdog";
import type { RailMethod } from "@/lib/rails";

export type SimulatedResult =
  | { ok: true; tx: { id: string; merchant_id: string; amount: number; currency: string; latency_ms: number | null; rail: string } }
  | { ok: false; status: 400 | 410 | 500; error: string };

/**
 * SIMULATED authorization (RAIL_MODE=simulated): flips PENDING -> SUCCESS with no money movement.
 * The institution comes from the transaction's own routing snapshot inside authorize_transaction_v2().
 * Never reachable in live mode: the callers refuse first, and the database function is service-role only after lockdown.
 */
export async function authorizeSimulated(admin: SupabaseClient, token: string, method: RailMethod): Promise<SimulatedResult> {
  const { data, error } = await admin.rpc("authorize_transaction_v2", { p_token: token, p_method: method });
  if (error) {
    if (error.message.includes("TOKEN_INVALID_OR_EXPIRED")) return { ok: false, status: 410, error: "Token invalid, used or expired" };
    if (error.message.includes("METHOD_NOT_AVAILABLE")) return { ok: false, status: 400, error: "The merchant does not accept that payment method" };
    console.error("[authorizeSimulated]", error.message);
    return { ok: false, status: 500, error: "Could not authorize the payment" };
  }

  // Watchdog rules run after the payer is already approved; they must never fail the payment.
  try {
    await Promise.all([checkVelocity(admin, data.merchant_id, data.id), checkAml(admin, data)]);
  } catch (e) {
    console.error("[authorizeSimulated] watchdog skipped:", (e as Error).message);
  }
  return { ok: true, tx: data };
}
