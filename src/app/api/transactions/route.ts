import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { isUuid } from "@/lib/settlement";
import { requireMerchant, roleOf, staffIdOf } from "@/lib/guard";
import { toConfirmation, type StaffLookup } from "@/lib/team";
import { createPayNode } from "@/lib/pay-nodes";

export const dynamic = "force-dynamic";

const MAX_PAGE = 1000;

/**
 * A merchant's transactions in [from, to), newest first, paged with limit/offset.
 * Used by the lookback, daily briefing and CSV export. Only the merchant (or an admin) may read them.
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
  // Team members see only the last 24 hours (enough for the shift); history and exports are for the owner.
  // A waiter sees only the sales they keyed themselves; a cashier sees everyone's.
  const role = guard.session ? roleOf(guard.session) : "OWNER";
  if (role !== "OWNER") {
    const floor = new Date(Date.now() - 24 * 3600_000).toISOString();
    if (new Date(from!).getTime() < Date.parse(floor)) from = floor;
  }
  const onlyStaff = role === "WAITER" ? staffIdOf(guard.session) : null;
  if (role === "WAITER" && !onlyStaff) return NextResponse.json({ error: "This waiter session is not linked to a team member. Sign in again." }, { status: 403 });
  const limit = Math.min(MAX_PAGE, Math.max(1, Number(q.get("limit")) || MAX_PAGE));
  const offset = Math.max(0, Number(q.get("offset")) || 0);

  try {
    const admin = getAdminClient();
    let query = admin.from("transactions").select("*").eq("merchant_id", merchantId).gte("created_at", from).lt("created_at", to);
    if (onlyStaff) query = query.eq("staff_id", onlyStaff);
    const { data, error } = await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: false }) // stable tiebreak so pages never overlap
      .range(offset, offset + limit); // one extra row tells the caller whether more remain
    if (error) {
      console.error("[transactions GET]", error.code, error.message);
      return NextResponse.json({ error: "Could not load transactions" }, { status: 500 });
    }
    const rows = data ?? [];
    // Rail credentials never leave the server: strip provider internals before returning.
    const page = rows.slice(0, limit);
    // Name the team member behind each sale (one lookup for the whole page).
    const staff: StaffLookup = {};
    const ids = [...new Set(page.map((r) => r.staff_id as string | null).filter((v): v is string => !!v))];
    if (ids.length) {
      const { data: members } = await admin.from("merchant_staff").select("id, name, team_no, role").eq("merchant_id", merchantId).in("id", ids);
      for (const m of members ?? []) staff[m.id] = { id: m.id, name: m.name, team_no: m.team_no, role: m.role };
    }
    const safe = page.map(({ rail_checkout_url, rail_session_id, rail_nonce, ...rest }) => ({ ...rest, confirmation: toConfirmation(rest as Parameters<typeof toConfirmation>[0], staff), staff_name: rest.staff_id ? (staff[rest.staff_id as string]?.name ?? null) : null, team_no: rest.staff_id ? (staff[rest.staff_id as string]?.team_no ?? null) : null }));
    return NextResponse.json({ rows: safe, hasMore: rows.length > limit }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}

/**
 * Create a PENDING transaction (dynamic pay node) with a 90s TTL and a node-priced orchestration fee.
 * The merchant's active bank/wallet are snapshotted (masked) onto the row server-side, so the payer can only
 * ever settle through institutions the merchant has enabled. Owners and cashiers may both do this.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const amount = Number(body?.amount);
  const merchantId = body?.merchant_id;

  if (!isUuid(merchantId) || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
    return NextResponse.json({ error: "Invalid merchant or amount" }, { status: 400 });
  }
  const guard = await requireMerchant(merchantId);
  if (!guard.ok) return guard.res;

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
  // A team member's sale carries their id (from the signed session). Removed members lose access at once.
  const staffId = staffIdOf(guard.session);
  if (staffId) {
    const { data: member } = await admin.from("merchant_staff").select("id").eq("id", staffId).eq("merchant_id", merchantId).eq("active", true).maybeSingle();
    if (!member) return NextResponse.json({ error: "Your access to this business was removed. Ask the owner." }, { status: 403 });
  }
  const r = await createPayNode(admin, merchantId, amount, "TERMINAL", staffId);
  return r.ok ? NextResponse.json(r.tx, { status: 201 }) : NextResponse.json(r.body, { status: r.status });
}