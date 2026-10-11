import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { railMode } from "@/lib/rails";

export const dynamic = "force-dynamic";

/** Validate a token (existence, status, expiry) and stamp the customer-open time. */
export async function GET(_: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    return NextResponse.json({ valid: false, reason: "MALFORMED" }, { status: 400 });
  }

  try {
    const { data, error } = await getAdminClient().rpc("open_transaction", { p_token: token });
    if (error) {
      console.error("[pay GET]", error.message);
      return NextResponse.json({ error: "Could not load this payment" }, { status: 500 });
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return NextResponse.json({ valid: false, reason: "NOT_FOUND" }, { status: 404 });

    // A payer who was sent to the rail and came back (cancelled, closed the tab) may try again.
    if (row.status === "PROCESSING") return NextResponse.json({ valid: true, tx: row, resumed: true, mode: railMode() });

    if (row.status !== "PENDING") return NextResponse.json({ valid: false, reason: "USED", tx: row }, { status: 410 });
    if (new Date(row.expires_at).getTime() <= Date.now()) return NextResponse.json({ valid: false, reason: "EXPIRED", tx: row }, { status: 410 });

    return NextResponse.json({ valid: true, tx: row, mode: railMode() });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
