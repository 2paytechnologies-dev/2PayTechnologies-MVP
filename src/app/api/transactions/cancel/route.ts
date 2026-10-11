import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Withdraw a superseded pay node. The terminal's QR rotates automatically, so each retired code is removed
 * instead of piling up as an expired PENDING row. Only a node that is still PENDING and that no payer has
 * opened can be removed; a paid, failed or in-use node is never touched.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const token = body?.token;
  if (typeof token !== "string" || !UUID.test(token)) return NextResponse.json({ error: "token (uuid) is required" }, { status: 400 });
  try {
    const { data, error } = await getAdminClient()
      .from("transactions")
      .delete()
      .eq("token", token)
      .eq("status", "PENDING")
      .is("viewed_at", null)
      .select("id");
    if (error) {
      console.error("[transactions/cancel]", error.message);
      return NextResponse.json({ error: "Could not cancel" }, { status: 500 });
    }
    return NextResponse.json({ cancelled: (data?.length ?? 0) > 0 });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
