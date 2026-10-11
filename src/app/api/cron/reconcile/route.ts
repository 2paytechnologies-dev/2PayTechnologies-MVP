import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { recordWatchdogEvent, safeEqual } from "@/lib/watchdog";

export const dynamic = "force-dynamic";

/** A payment this long in PROCESSING without a callback needs a human to check with the rail. */
const STALE_AFTER_MS = 45 * 60_000;

/**
 * Scheduled reconciliation (see vercel.json). Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`.
 * It never changes a sale's status: money may have moved even if the callback was lost, so a stuck payment is
 * raised to the admin hub as a watchdog event instead of being failed automatically, and a late callback can
 * still settle it.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  if (!safeEqual(`Bearer ${secret}`, req.headers.get("authorization") ?? "")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const admin = getAdminClient();
    const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
    const { data: stale, error } = await admin
      .from("transactions")
      .select("id, merchant_id, amount, currency, rail, rail_provider, processing_at")
      .eq("status", "PROCESSING")
      .lt("processing_at", cutoff)
      .limit(200);
    if (error) {
      console.error("[reconcile]", error.message);
      return NextResponse.json({ error: "Query failed" }, { status: 500 });
    }

    let raised = 0;
    for (const tx of stale ?? []) {
      const { count } = await admin
        .from("watchdog_events")
        .select("id", { count: "exact", head: true })
        .eq("transaction_id", tx.id)
        .eq("event_type", "SETTLEMENT_MISMATCH")
        .like("message", "Payment stuck%");
      if ((count ?? 0) > 0) continue; // already raised
      const ok = await recordWatchdogEvent(admin, {
        event_type: "SETTLEMENT_MISMATCH",
        severity: "WARNING",
        risk_score: 55,
        merchant_id: tx.merchant_id,
        transaction_id: tx.id,
        message: `Payment stuck in PROCESSING since ${tx.processing_at}: no ${tx.rail_provider ?? "rail"} callback for ${tx.amount} ${tx.currency} via ${tx.rail}. Check with the rail before retrying.`,
        details: { provider: tx.rail_provider, processing_at: tx.processing_at },
      });
      if (ok) raised++;
    }
    return NextResponse.json({ checked: stale?.length ?? 0, raised });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
