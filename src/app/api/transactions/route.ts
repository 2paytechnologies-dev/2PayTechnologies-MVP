import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { feeBreakdown } from "@/lib/fee";
import { getAdminClient } from "@/lib/supabase-admin";
import { nodeFeeContext } from "@/lib/watchdog";

export const dynamic = "force-dynamic";

/** Create a PENDING transaction (dynamic pay node) with a 90s TTL and a node-priced orchestration fee. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const amount = Number(body?.amount);
  const merchantId = body?.merchant_id;

  if (!merchantId || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
    return NextResponse.json({ error: "Invalid merchant or amount" }, { status: 400 });
  }

  const rounded = Math.round(amount * 100) / 100;

  // F_t needs the node's risk/traffic/loyalty. Without the service-role key (or on any lookup error)
  // the node is priced neutrally, so a missing key never blocks a sale.
  let ctx = { risk: 0, traffic: 0, credit: 0 };
  try {
    ctx = await nodeFeeContext(getAdminClient(), merchantId);
  } catch {
    /* neutral pricing */
  }
  const { fee } = feeBreakdown({ volume: rounded, ...ctx });

  const { data, error } = await supabase
    .from("transactions")
    .insert({
      merchant_id: merchantId,
      amount: rounded,
      expected_amount: rounded,
      fee_ft: fee,
      expires_at: new Date(Date.now() + 90_000).toISOString(),
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
