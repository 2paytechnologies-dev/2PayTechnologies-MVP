import type { SupabaseClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";
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

/** Constant-time string comparison for shared secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
