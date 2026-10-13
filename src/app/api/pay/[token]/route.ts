import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { railMode } from "@/lib/rails";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Who is serving this table (name and team number), so the customer can see it and add a tip for them. null if none. */
async function servedBy(admin: SupabaseClient, token: string): Promise<{ name: string; team_no: string | null } | null> {
  try {
    const { data } = await admin.from("transactions").select("staff_id").eq("token", token).maybeSingle();
    if (!data?.staff_id) return null;
    const { data: s } = await admin.from("merchant_staff").select("name, team_no").eq("id", data.staff_id).maybeSingle();
    return s ? { name: s.name as string, team_no: (s.team_no as string | null) ?? null } : null;
  } catch {
    return null; // a missing name must never block a payment
  }
}

export const dynamic = "force-dynamic";

/** Validate a token (existence, status, expiry) and stamp the customer-open time. */
export async function GET(_: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    return NextResponse.json({ valid: false, reason: "MALFORMED" }, { status: 400 });
  }

  try {
    const admin = getAdminClient();
    const { data, error } = await admin.rpc("open_transaction", { p_token: token });
    if (error) {
      console.error("[pay GET]", error.message);
      return NextResponse.json({ error: "Could not load this payment" }, { status: 500 });
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return NextResponse.json({ valid: false, reason: "NOT_FOUND" }, { status: 404 });

    // A payer who was sent to the rail and came back (cancelled, closed the tab) may try again.
    if (row.status === "PROCESSING") return NextResponse.json({ valid: true, tx: row, resumed: true, mode: railMode(), served_by: await servedBy(admin, token) });

    if (row.status !== "PENDING") return NextResponse.json({ valid: false, reason: "USED", tx: row }, { status: 410 });
    if (new Date(row.expires_at).getTime() <= Date.now()) return NextResponse.json({ valid: false, reason: "EXPIRED", tx: row }, { status: 410 });

    return NextResponse.json({ valid: true, tx: row, mode: railMode(), served_by: await servedBy(admin, token) });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
