import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { computeFee } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Create a PENDING transaction (dynamic pay node) with a 90s TTL. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const amount = Number(body?.amount);
  const merchantId = body?.merchant_id;

  if (!merchantId || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
    return NextResponse.json({ error: "Invalid merchant or amount" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("transactions")
    .insert({
      merchant_id: merchantId,
      amount: Math.round(amount * 100) / 100,
      fee_ft: computeFee(amount),
      expires_at: new Date(Date.now() + 90_000).toISOString(),
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
