import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { safeEqual } from "@/lib/watchdog";

export const dynamic = "force-dynamic";

/**
 * Scheduled housekeeping (see vercel.json). Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`.
 *
 * Always safe: old rate-limit counters (>2 days) and old error reports (>30 days) are removed.
 *
 * OFF BY DEFAULT: deleting old transactions. Set RETENTION_PURGE_DAYS (minimum 365) to enable it. It then deletes only
 * transactions that are finished (SETTLED or FAILED) and older than that many days, with their refund requests and
 * payer contacts. The dashboards promise merchants 365 days of records; financial-record law may require you to keep
 * records LONGER, so confirm the required retention period with counsel before turning this on.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  if (!safeEqual(`Bearer ${secret}`, req.headers.get("authorization") ?? "")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const admin = getAdminClient();
    const day = 86_400_000;
    const out: Record<string, number | string> = {};

    const rl = await admin.from("rate_limits").delete().lt("bucket", new Date(Date.now() - 2 * day).toISOString()).select("key");
    out.rateLimitRowsRemoved = rl.data?.length ?? 0;
    const er = await admin.from("app_errors").delete().lt("created_at", new Date(Date.now() - 30 * day).toISOString()).select("id");
    out.errorRowsRemoved = er.data?.length ?? 0;

    const days = Number(process.env.RETENTION_PURGE_DAYS);
    if (!process.env.RETENTION_PURGE_DAYS) {
      out.transactionPurge = "disabled";
    } else if (!Number.isFinite(days) || days < 365) {
      out.transactionPurge = "refused: RETENTION_PURGE_DAYS must be at least 365";
    } else {
      const cutoff = new Date(Date.now() - days * day).toISOString();
      const { data: old } = await admin.from("transactions").select("id").in("status", ["SETTLED", "FAILED"]).lt("created_at", cutoff).limit(500);
      const ids = (old ?? []).map((t) => t.id as string);
      if (ids.length) {
        await admin.from("refund_requests").delete().in("transaction_id", ids);
        await admin.from("rail_events").delete().in("transaction_id", ids);
        await admin.from("watchdog_events").delete().in("transaction_id", ids);
        await admin.from("ad_impressions").delete().in("transaction_id", ids);
        await admin.from("transactions").delete().in("id", ids); // payer_contacts cascade
      }
      out.transactionsPurged = ids.length;
    }
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    console.error("[retention]", (e as Error).message);
    return NextResponse.json({ error: "Retention run failed" }, { status: 500 });
  }
}
