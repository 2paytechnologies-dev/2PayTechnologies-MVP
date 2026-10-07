import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** Validate a token (existence, status, expiry) and stamp the customer-open time. */
export async function GET(_: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    return NextResponse.json({ valid: false, reason: "MALFORMED" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("open_transaction", { p_token: token });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return NextResponse.json({ valid: false, reason: "NOT_FOUND" }, { status: 404 });
  if (row.status !== "PENDING") return NextResponse.json({ valid: false, reason: "USED", tx: row }, { status: 410 });
  if (new Date(row.expires_at).getTime() <= Date.now())
    return NextResponse.json({ valid: false, reason: "EXPIRED", tx: row }, { status: 410 });

  return NextResponse.json({ valid: true, tx: row });
}
