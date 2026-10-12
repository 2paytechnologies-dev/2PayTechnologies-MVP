import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireMerchant } from "@/lib/guard";
import { isUuid } from "@/lib/settlement";

export const dynamic = "force-dynamic";

const TYPES = ["VELOCITY_SPIKE", "ECR_MISMATCH", "FUEL_TELEMETRY", "AML_FIS_SAR", "SETTLEMENT_MISMATCH"];

/** Count of a merchant's watchdog events of one type since a time (the daily briefing's reconciliation status). */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const merchantId = q.get("merchant_id") ?? "";
  const type = q.get("type") ?? "";
  const since = q.get("since") ?? "";
  if (!isUuid(merchantId) || !TYPES.includes(type) || Number.isNaN(Date.parse(since))) {
    return NextResponse.json({ error: "merchant_id, type and since are required" }, { status: 400 });
  }
  const guard = await requireMerchant(merchantId, { owner: true });
  if (!guard.ok) return guard.res;
  try {
    const { count, error } = await getAdminClient()
      .from("watchdog_events")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .eq("event_type", type)
      .gte("created_at", since);
    if (error) return NextResponse.json({ error: "Could not count events" }, { status: 500 });
    return NextResponse.json({ count: count ?? 0 }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
