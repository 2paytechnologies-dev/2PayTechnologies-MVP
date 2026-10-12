import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/guard";

export const dynamic = "force-dynamic";

/** Businesses waiting for (or past) verification. The full TIN is shown here, to admins only, because they must check it. */
export async function GET(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  const status = new URL(req.url).searchParams.get("status") ?? "SUBMITTED";
  if (!["UNVERIFIED", "SUBMITTED", "VERIFIED", "REJECTED"].includes(status)) return NextResponse.json({ error: "Bad status" }, { status: 400 });
  try {
    const { data, error } = await getAdminClient()
      .from("merchants")
      .select("id, business_name, terminal_id, category, phone, legal_name, tin, business_license, address, location, kyc_status, kyc_note, kyc_submitted_at, kyc_reviewed_at")
      .eq("kyc_status", status)
      .order("kyc_submitted_at", { ascending: true, nullsFirst: false })
      .limit(200);
    if (error) return NextResponse.json({ error: "Could not load verifications" }, { status: 500 });
    return NextResponse.json(data ?? [], { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
