import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { authorizeSimulated } from "@/lib/payments";
import { railMode } from "@/lib/rails";

export const dynamic = "force-dynamic";

/**
 * SIMULATED authorization, kept for demos. In live mode this route refuses outright: with real money at stake,
 * the only way a sale becomes paid is a verified callback from the rail (see /api/webhooks/[provider]).
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  if (railMode() === "live") {
    return NextResponse.json({ error: "Simulated authorization is disabled in live mode" }, { status: 403 });
  }
  const { token } = await params;
  const body = await req.json().catch(() => ({}));
  const method = body?.method === "bank" || body?.method === "wallet" ? body.method : null;
  if (!method) return NextResponse.json({ error: "method must be 'bank' or 'wallet'" }, { status: 400 });

  try {
    const r = await authorizeSimulated(getAdminClient(), token, method);
    return r.ok ? NextResponse.json(r.tx) : NextResponse.json({ error: r.error }, { status: r.status });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
