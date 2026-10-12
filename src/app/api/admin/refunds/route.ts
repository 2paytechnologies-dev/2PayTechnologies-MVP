import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/guard";
import { referenceFor } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Refund requests across all merchants, open ones first. */
export async function GET(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  const status = new URL(req.url).searchParams.get("status");
  try {
    let q = getAdminClient()
      .from("refund_requests")
      .select("id, transaction_id, merchant_id, amount, reason, status, requested_by, admin_note, created_at, updated_at, merchants(business_name, terminal_id)")
      .order("created_at", { ascending: false })
      .limit(200);
    if (status && ["REQUESTED", "APPROVED", "REFUNDED", "REJECTED"].includes(status)) q = q.eq("status", status);
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: "Could not load refund requests" }, { status: 500 });
    const rows = (data ?? []).map((r) => {
      const m = (Array.isArray(r.merchants) ? r.merchants[0] : r.merchants) as { business_name: string; terminal_id: string } | null;
      const { merchants: _m, ...rest } = r;
      return { ...rest, reference: referenceFor(r.transaction_id), business_name: m?.business_name ?? "", terminal_id: m?.terminal_id ?? "" };
    });
    const rank: Record<string, number> = { REQUESTED: 0, APPROVED: 1, REFUNDED: 2, REJECTED: 3 };
    rows.sort((a, b) => rank[a.status] - rank[b.status]);
    return NextResponse.json(rows, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
