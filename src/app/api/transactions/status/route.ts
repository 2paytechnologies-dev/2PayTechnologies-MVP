import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Status of specific pay nodes, for the terminal's "customer paid" detection.
 * The unguessable pay tokens are the credential, so no session is needed: the terminal only ever asks about
 * tokens it just minted. Returns only what the terminal needs.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("tokens") ?? "";
  const tokens = raw.split(",").map((t) => t.trim()).filter(Boolean);
  if (!tokens.length || tokens.length > 12 || !tokens.every((t) => UUID.test(t))) {
    return NextResponse.json({ error: "tokens must be 1-12 comma-separated uuids" }, { status: 400 });
  }
  try {
    const { data, error } = await getAdminClient()
      .from("transactions")
      .select("id, token, status, amount, tip_amount, currency, latency_ms, rail, settlement_method, settled_at")
      .in("token", tokens);
    if (error) {
      console.error("[transactions/status]", error.message);
      return NextResponse.json({ error: "Could not load status" }, { status: 500 });
    }
    return NextResponse.json(data ?? [], { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
