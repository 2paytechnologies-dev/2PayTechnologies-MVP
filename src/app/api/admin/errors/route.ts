import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/guard";

export const dynamic = "force-dynamic";

/** Recent client and server errors reported by the apps (see /api/telemetry/error). */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  try {
    const { data, error } = await getAdminClient().from("app_errors").select("id, source, message, url, user_agent, merchant_id, created_at").order("created_at", { ascending: false }).limit(100);
    if (error) return NextResponse.json({ error: "Could not load errors" }, { status: 500 });
    return NextResponse.json(data ?? [], { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
