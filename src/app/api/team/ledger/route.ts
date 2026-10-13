import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { isUuid } from "@/lib/settlement";
import { requireMerchant, roleOf, staffIdOf } from "@/lib/guard";
import { buildLedger, type StaffLookup } from "@/lib/team";

export const dynamic = "force-dynamic";

const MAX_ROWS = 5000;

/**
 * The shift ledger: paid sales grouped by who took them, split into revenue (what was keyed) and tips (what the customer
 * paid on top). The owner and the cashier see every team member; a waiter sees only their own line.
 * Query: merchant_id, from and to (ISO timestamps). Team members are limited to the last 24 hours.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const merchantId = q.get("merchant_id") ?? "";
  if (!isUuid(merchantId)) return NextResponse.json({ error: "merchant_id (uuid) is required" }, { status: 400 });
  const guard = await requireMerchant(merchantId);
  if (!guard.ok) return guard.res;

  let from = q.get("from");
  const to = q.get("to");
  if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    return NextResponse.json({ error: "from and to (ISO timestamps) are required" }, { status: 400 });
  }
  const role = guard.session ? roleOf(guard.session) : "OWNER";
  if (role !== "OWNER") {
    const floor = new Date(Date.now() - 24 * 3600_000).toISOString();
    if (Date.parse(from) < Date.parse(floor)) from = floor;
  }
  const onlyStaff = role === "WAITER" ? staffIdOf(guard.session) : null;
  if (role === "WAITER" && !onlyStaff) return NextResponse.json({ error: "This waiter session is not linked to a team member. Sign in again." }, { status: 403 });

  try {
    const admin = getAdminClient();
    let query = admin
      .from("transactions")
      .select("id, merchant_id, staff_id, amount, tip_amount, currency, rail, settlement_method, status, settled_at, created_at")
      .eq("merchant_id", merchantId)
      .in("status", ["SUCCESS", "SETTLED"])
      .gte("created_at", from)
      .lt("created_at", to)
      .order("created_at", { ascending: false })
      .limit(MAX_ROWS);
    if (onlyStaff) query = query.eq("staff_id", onlyStaff);
    const { data, error } = await query;
    if (error) {
      console.error("[team/ledger]", error.code, error.message);
      return NextResponse.json({ error: "Could not load the ledger" }, { status: 500 });
    }
    const rows = data ?? [];

    // Everyone on the team, including people since removed, so past sales still carry the right name.
    const staff: StaffLookup = {};
    const { data: members } = await admin.from("merchant_staff").select("id, name, team_no, role").eq("merchant_id", merchantId);
    for (const m of members ?? []) staff[m.id] = { id: m.id, name: m.name, team_no: m.team_no, role: m.role };

    const lines = buildLedger(rows, staff);
    const totals = lines.reduce((a, l) => ({ sales: a.sales + l.sales, revenue: a.revenue + l.revenue, tips: a.tips + l.tips }), { sales: 0, revenue: 0, tips: 0 });
    const round2 = (n: number) => Math.round(n * 100) / 100;
    return NextResponse.json(
      { lines, totals: { sales: totals.sales, revenue: round2(totals.revenue), tips: round2(totals.tips), total: round2(totals.revenue + totals.tips) }, truncated: rows.length >= MAX_ROWS },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}