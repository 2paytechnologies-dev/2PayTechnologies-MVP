import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/guard";

export const dynamic = "force-dynamic";

/** The most recent audit entries, optionally for one merchant. */
export async function GET(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  const q = new URL(req.url).searchParams;
  const limit = Math.min(300, Math.max(1, Number(q.get("limit")) || 100));
  const merchant = q.get("merchant_id");
  try {
    let query = getAdminClient().from("audit_log").select("*").order("created_at", { ascending: false }).limit(limit);
    if (merchant && /^[0-9a-f-]{36}$/i.test(merchant)) query = query.eq("actor_merchant_id", merchant);
    const { data, error } = await query;
    if (error) return NextResponse.json({ error: "Could not load the audit log" }, { status: 500 });
    return NextResponse.json(data ?? [], { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
