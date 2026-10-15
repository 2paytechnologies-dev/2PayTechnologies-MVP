import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/guard";
import { eatDateKey, eatDayStartISO } from "@/lib/format";
import { EMPTY_STATS, type DayStats, type NodeFee } from "@/lib/admin-types";

export const dynamic = "force-dynamic";

const EVENT_CAP = 200;
const NODE_LIMIT = 25;

/**
 * What the admin dashboards show, in one call. The totals (volume, taps, latency, by channel, the fee ledger) are computed IN THE DATABASE
 * for today's Addis Ababa day, so they stay correct however many sales there are; the busiest nodes are a short list; the latest watchdog
 * events come with their business names. Nothing here grows with the number of merchants or sales. Admin only when authentication is enforced.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;

  try {
    const admin = getAdminClient();
    const since = eatDayStartISO(eatDateKey(new Date()));
    const [stats, nodes, ev] = await Promise.all([
      admin.rpc("admin_day_stats", { p_from: since }),
      admin.rpc("admin_node_fees", { p_from: since, p_limit: NODE_LIMIT }),
      admin.from("watchdog_events").select("*").order("created_at", { ascending: false }).limit(EVENT_CAP),
    ]);
    if (stats.error || nodes.error) {
      console.error("[admin/overview]", stats.error?.message ?? nodes.error?.message);
      return NextResponse.json({ error: "Could not load the overview. Has supabase/v2_6.sql been run?" }, { status: 500 });
    }

    const events = ev.data ?? [];
    const ids = [...new Set(events.map((e) => e.merchant_id as string | null).filter((v): v is string => !!v))].slice(0, 200);
    const names = new Map<string, { business_name: string; terminal_id: string }>();
    if (ids.length) {
      const { data } = await admin.from("merchants").select("id, business_name, terminal_id").in("id", ids);
      for (const m of data ?? []) names.set(m.id as string, { business_name: m.business_name as string, terminal_id: m.terminal_id as string });
    }

    // Recent Watchdog risk per node, for context beside what each node was charged.
    const hourAgo = Date.now() - 3_600_000;
    const risk = (id: string) => {
      const r = events.filter((e) => e.merchant_id === id && new Date(e.created_at as string).getTime() >= hourAgo);
      return { risk: r.length ? r.reduce((s, e) => s + Number(e.risk_score), 0) / r.length : 0, signals: r.length };
    };
    const nodeRows: NodeFee[] = ((nodes.data ?? []) as Omit<NodeFee, "risk" | "signals">[]).map((n) => ({ ...n, ...risk(n.merchant_id) }));

    return NextResponse.json(
      {
        stats: (stats.data ?? EMPTY_STATS) as DayStats,
        nodes: nodeRows,
        events: events.map((e) => ({ ...e, business_name: names.get(e.merchant_id as string)?.business_name ?? null, terminal_id: names.get(e.merchant_id as string)?.terminal_id ?? null })),
        eventsError: ev.error ? ev.error.message : null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
