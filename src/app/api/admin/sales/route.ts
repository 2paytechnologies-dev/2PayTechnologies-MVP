import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/guard";
import { shapeSale } from "@/lib/compliance-sales";

export const dynamic = "force-dynamic";

const DAY = 86_400_000;

/**
 * Look up paid sales for the admin screens: the latest few, or a search by (the start of) a transaction id, a terminal id or a business
 * name, inside a date range. Always a small page (25 by default, 100 at most): the database does the work, so it is the same speed at a
 * thousand sales or a hundred million. Evidence only: account numbers are the masked ones recorded on the sale.
 */
export async function GET(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  const q = new URL(req.url).searchParams;
  const search = (q.get("q") ?? "").trim().slice(0, 60);
  const limit = Math.min(100, Math.max(1, Number(q.get("limit")) || 25));
  const from = q.get("from") && !Number.isNaN(Date.parse(q.get("from")!)) ? new Date(q.get("from")!).toISOString() : new Date(Date.now() - 7 * DAY).toISOString();
  const to = q.get("to") && !Number.isNaN(Date.parse(q.get("to")!)) ? new Date(q.get("to")!).toISOString() : new Date(Date.now() + DAY).toISOString();
  try {
    const admin = getAdminClient();
    const { data, error } = await admin.rpc("admin_find_sales", { p_q: search, p_from: from, p_to: to, p_limit: limit });
    if (error) {
      console.error("[admin/sales]", error.message);
      return NextResponse.json({ error: "Could not load sales. Has supabase/v2_6.sql been run?" }, { status: 500 });
    }
    return NextResponse.json({ sales: ((data ?? []) as Record<string, unknown>[]).map(shapeSale), limit }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
