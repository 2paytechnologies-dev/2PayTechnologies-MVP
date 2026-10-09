import type { SupabaseClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";
import { LATENCY_TARGET_S, type FeeInputs } from "@/lib/fee";
import type { WatchdogEventType, WatchdogSeverity } from "@/lib/types";

/** Server-only helpers for the 2Pay Watchdog. Import from route handlers only. */

export const VELOCITY_WINDOW_S = 60;
export const VELOCITY_THRESHOLD = 5; // settled taps per terminal inside the window
/**
 * Single-transaction amount that triggers an automatic Suspicious Activity Report
 * draft for the FIS. PLACEHOLDER: set AML_SAR_THRESHOLD_ETB to the figure your
 * compliance officer confirms.
 */
export const AML_SAR_THRESHOLD_ETB = Number(process.env.AML_SAR_THRESHOLD_ETB) || 500_000;

export interface NewWatchdogEvent {
  event_type: WatchdogEventType;
  severity: WatchdogSeverity;
  risk_score: number;
  merchant_id?: string | null;
  transaction_id?: string | null;
  message: string;
  details?: Record<string, unknown>;
}

export async function recordWatchdogEvent(admin: SupabaseClient, evt: NewWatchdogEvent) {
  const { error } = await admin.from("watchdog_events").insert({
    event_type: evt.event_type,
    severity: evt.severity,
    risk_score: Math.max(0, Math.min(100, Math.round(evt.risk_score))),
    merchant_id: evt.merchant_id ?? null,
    transaction_id: evt.transaction_id ?? null,
    message: evt.message,
    details: evt.details ?? {},
  });
  if (error) console.error("[watchdog] insert failed:", error.message);
  return !error;
}

/** Rapid repeated transactions on one terminal. Called after a payment is authorized. */
export async function checkVelocity(admin: SupabaseClient, merchantId: string, transactionId: string) {
  const since = new Date(Date.now() - VELOCITY_WINDOW_S * 1000).toISOString();
  const { count, error } = await admin
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", merchantId)
    .in("status", ["SUCCESS", "SETTLED"])
    .gte("created_at", since);
  if (error || count == null || count < VELOCITY_THRESHOLD) return;

  const over = count - VELOCITY_THRESHOLD;
  await recordWatchdogEvent(admin, {
    event_type: "VELOCITY_SPIKE",
    severity: over >= 5 ? "CRITICAL" : over >= 2 ? "HIGH" : "WARNING",
    risk_score: 50 + over * 8,
    merchant_id: merchantId,
    transaction_id: transactionId,
    message: `${count} settled taps in ${VELOCITY_WINDOW_S}s on one terminal (threshold ${VELOCITY_THRESHOLD}).`,
    details: { count, window_s: VELOCITY_WINDOW_S, threshold: VELOCITY_THRESHOLD },
  });
}

/** Large single transactions are drafted as SARs awaiting filing with the Financial Intelligence Service. */
export async function checkAml(
  admin: SupabaseClient,
  tx: { id: string; merchant_id: string; amount: number; currency: string },
) {
  if (Number(tx.amount) < AML_SAR_THRESHOLD_ETB) return;
  await recordWatchdogEvent(admin, {
    event_type: "AML_FIS_SAR",
    severity: "HIGH",
    risk_score: 80,
    merchant_id: tx.merchant_id,
    transaction_id: tx.id,
    message: `Transaction of ${tx.amount} ${tx.currency} exceeds the SAR threshold (${AML_SAR_THRESHOLD_ETB}). Marked for FIS filing.`,
    details: { fis_status: "PENDING_FILING", threshold: AML_SAR_THRESHOLD_ETB, amount: tx.amount },
  });
}

/**
 * Per-node fee inputs (R_t, T_t, C_t) for the orchestration fee, from the last hour of
 * watchdog events and the node's recent settled taps. Any failure degrades to a neutral node.
 */
export async function nodeFeeContext(admin: SupabaseClient, merchantId: string): Promise<Omit<FeeInputs, "volume">> {
  const neutral = { risk: 0, traffic: 0, credit: 0 };
  try {
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    const [ev, tx] = await Promise.all([
      admin.from("watchdog_events").select("risk_score").eq("merchant_id", merchantId).gte("created_at", hourAgo).limit(200),
      admin
        .from("transactions")
        .select("latency_ms")
        .eq("merchant_id", merchantId)
        .in("status", ["SUCCESS", "SETTLED"])
        .gte("created_at", dayAgo)
        .order("created_at", { ascending: false })
        .limit(500),
    ]);
    if (ev.error || tx.error) return neutral;
    const scores = (ev.data ?? []).map((r) => Number(r.risk_score));
    const lats = (tx.data ?? []).map((r) => r.latency_ms).filter((l): l is number => l != null);
    const meanLatency = lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length / 1000 : 0;
    return {
      risk: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
      traffic: Math.max(0, meanLatency - LATENCY_TARGET_S),
      credit: (tx.data ?? []).length,
    };
  } catch {
    return neutral;
  }
}

/** Constant-time string comparison for shared secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
