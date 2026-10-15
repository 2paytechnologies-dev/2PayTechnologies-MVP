import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/guard";
import { eatDateKey, eatDayStartISO } from "@/lib/format";
import { MERCHANT_PUBLIC_COLUMNS } from "@/lib/types";

export const dynamic = "force-dynamic";

const TX_CAP = 1000;
const EVENT_CAP = 200;

/**
 * Everything the admin dashboards show, in one call: today's transactions (Addis Ababa day), the latest
 * watchdog events and the merchant list. Admin only when authentication is enforced.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;

  try {
    const admin = getAdminClient();
    const since = eatDayStartISO(eatDateKey(new Date()));
    const [tx, ev, m] = await Promise.all([
      admin
        .from("transactions")
        .select("id, merchant_id, amount, currency, status, rail, fee_ft, base_fee, vat_fee, net_merchant_settlement, source, rail_provider, latency_ms, expires_at, created_at, settled_at, settlement_method")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(TX_CAP),
      admin.from("watchdog_events").select("*").order("created_at", { ascending: false }).limit(EVENT_CAP),
      admin.from("merchants").select(MERCHANT_PUBLIC_COLUMNS).order("business_name"),
    ]);
    if (tx.error || m.error) {
      console.error("[admin/overview]", tx.error?.message ?? m.error?.message);
      return NextResponse.json({ error: "Could not load the overview" }, { status: 500 });
    }
    return NextResponse.json(
      { transactions: tx.data ?? [], events: ev.data ?? [], eventsError: ev.error ? ev.error.message : null, merchants: m.data ?? [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
