import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { railMode } from "@/lib/rails";
import type { SupabaseClient } from "@supabase/supabase-js";
import { openAccounts, type StoredAccount } from "@/lib/fieldcrypt";
import { maskAccount } from "@/lib/settlement";

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

/** A ride-hailing sale: every account the driver can be paid on (masked), so the passenger can pick one directly. Null for any other sale. */
async function payeeOptions(admin: SupabaseClient, token: string): Promise<{ id: string; institution: string; account_masked: string }[] | null> {
  try {
    const { data } = await admin.from("transactions").select("payee_accounts").eq("token", token).maybeSingle();
    if (!data?.payee_accounts) return null;
    return openAccounts(data.payee_accounts as StoredAccount[]).map((a) => ({ id: a.id, institution: a.institution, account_masked: maskAccount(a.account_number) }));
  } catch {
    return null; // never block a payment over a display detail
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

    const [served_by, options] = await Promise.all([servedBy(admin, token), payeeOptions(admin, token)]);
    return NextResponse.json({ valid: true, tx: options ? { ...row, payee_options: options } : row, mode: railMode(), served_by });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
