import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/guard";
import { isUuid } from "@/lib/settlement";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** Approve or reject a submitted business. Rejection needs a reason the merchant can act on. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "Malformed id" }, { status: 400 });
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  const body = await req.json().catch(() => null);
  const status = body?.status;
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 300) : "";
  if (status !== "VERIFIED" && status !== "REJECTED") return NextResponse.json({ error: "status must be VERIFIED or REJECTED" }, { status: 400 });
  if (status === "REJECTED" && !note) return NextResponse.json({ error: "Give the merchant a reason for rejecting" }, { status: 400 });

  try {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from("merchants")
      .update({ kyc_status: status, kyc_note: note || null, kyc_reviewed_at: new Date().toISOString() })
      .eq("id", id)
      .eq("kyc_status", "SUBMITTED") // only a submitted business can be reviewed, and only once
      .select("id, kyc_status")
      .maybeSingle();
    if (error) return NextResponse.json({ error: "Could not update" }, { status: 500 });
    if (!data) return NextResponse.json({ error: "This business is not waiting for review" }, { status: 409 });
    await audit(admin, guard.session, req, { action: `kyc.${String(status).toLowerCase()}`, targetType: "merchant", targetId: id, merchantId: id, details: { note } });
    return NextResponse.json(data);
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
