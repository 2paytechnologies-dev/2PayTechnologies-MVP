import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { RAILS } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Simulated inherited authorization: flips PENDING -> SUCCESS atomically (single use). */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const body = await req.json().catch(() => ({}));
  const rail = RAILS.includes(body?.rail) ? body.rail : "EthioPay-IPS";

  const { data, error } = await supabase.rpc("authorize_transaction", { p_token: token, p_rail: rail });
  if (error) {
    const expired = error.message.includes("TOKEN_INVALID_OR_EXPIRED");
    return NextResponse.json({ error: expired ? "Token invalid, used or expired" : error.message }, { status: expired ? 410 : 500 });
  }
  return NextResponse.json(data);
}
