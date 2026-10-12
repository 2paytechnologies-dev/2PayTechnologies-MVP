import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { isUuid } from "@/lib/settlement";
import { requireMerchant, roleOf } from "@/lib/guard";
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
  // A cashier sees only the last 24 hours (enough for the shift); history and exports are for the owner.
  if (guard.session && roleOf(guard.session) === "CASHIER") {
    const floor = new Date(Date.now() - 24 * 3600_000).toISOString();
    if (new Date(from!).getTime() < Date.parse(floor)) from = floor;
  }
  const limit = Math.min(MAX_PAGE, Math.max(1, Number(q.get("limit")) || MAX_PAGE));
  const offset = Math.max(0, Number(q.get("offset")) || 0);

  try {
    const { data, error } = await getAdminClient()
      .from("transactions")
      .select("*")
      .eq("merchant_id", merchantId)
      .gte("created_at", from)
      .lt("created_at", to)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false }) // stable tiebreak so pages never overlap
      .range(offset, offset + limit); // one extra row tells the caller whether more remain
    if (error) {
      console.error("[transactions GET]", error.code, error.message);
      return NextResponse.json({ error: "Could not load transactions" }, { status: 500 });
    }
    const rows = data ?? [];
    // Rail credentials never leave the server: strip provider internals before returning.
    const safe = rows.slice(0, limit).map(({ rail_checkout_url, rail_session_id, rail_nonce, ...rest }) => rest);
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
  const r = await createPayNode(admin, merchantId, amount, "TERMINAL");
  return r.ok ? NextResponse.json(r.tx, { status: 201 }) : NextResponse.json(r.body, { status: r.status });
}