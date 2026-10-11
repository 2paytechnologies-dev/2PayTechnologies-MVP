import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getAdminClient } from "@/lib/supabase-admin";
import { checkAml, checkVelocity } from "@/lib/watchdog";

export const dynamic = "force-dynamic";

/**
 * Simulated inherited authorization: flips PENDING -> SUCCESS atomically (single use).
 * The payer sends only `method` ("bank" | "wallet"); the institution is read from the transaction's own
 * routing snapshot inside authorize_transaction_v2(), so it cannot be spoofed from the browser.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const body = await req.json().catch(() => ({}));
  const method = body?.method === "bank" || body?.method === "wallet" ? body.method : null;
  if (!method) return NextResponse.json({ error: "method must be 'bank' or 'wallet'" }, { status: 400 });

  const { data, error } = await supabase.rpc("authorize_transaction_v2", { p_token: token, p_method: method });
  if (error) {
    if (error.message.includes("TOKEN_INVALID_OR_EXPIRED"))
      return NextResponse.json({ error: "Token invalid, used or expired" }, { status: 410 });
    if (error.message.includes("METHOD_NOT_AVAILABLE"))
      return NextResponse.json({ error: "The merchant does not accept that payment method" }, { status: 400 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Watchdog rules run after the payer is already approved; they must never fail the payment.
  try {
    const admin = getAdminClient();
    await Promise.all([checkVelocity(admin, data.merchant_id, data.id), checkAml(admin, data)]);
  } catch (e) {
    console.error("[authorize] watchdog skipped:", (e as Error).message);
  }

  return NextResponse.json(data);
}
