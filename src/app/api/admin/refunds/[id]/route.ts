import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/guard";
import { isUuid } from "@/lib/settlement";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** Allowed moves. A request is approved first; the money is returned with the provider; then it is marked REFUNDED. */
const NEXT: Record<string, string[]> = { REQUESTED: ["APPROVED", "REJECTED"], APPROVED: ["REFUNDED", "REJECTED"], REFUNDED: [], REJECTED: [] };

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "Malformed id" }, { status: 400 });
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  const body = await req.json().catch(() => null);
  const status = body?.status;
  const note = typeof body?.admin_note === "string" ? body.admin_note.trim().slice(0, 300) : "";
  if (!["APPROVED", "REFUNDED", "REJECTED"].includes(status)) return NextResponse.json({ error: "status must be APPROVED, REFUNDED or REJECTED" }, { status: 400 });
  if (status === "REJECTED" && !note) return NextResponse.json({ error: "Give the merchant a reason for rejecting" }, { status: 400 });

  try {
    const admin = getAdminClient();
    const { data: cur } = await admin.from("refund_requests").select("id, status, merchant_id, amount").eq("id", id).maybeSingle();
    if (!cur) return NextResponse.json({ error: "Refund request not found" }, { status: 404 });
    if (!NEXT[cur.status]?.includes(status)) return NextResponse.json({ error: `A ${cur.status} request cannot become ${status}` }, { status: 409 });

    // The status guard in the update makes the transition single-shot even if two admins click at once.
    const { data, error } = await admin
      .from("refund_requests")
      .update({ status, admin_note: note || null, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", cur.status)
      .select("id, status")
      .maybeSingle();
    if (error) return NextResponse.json({ error: "Could not update the request" }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Someone else just changed this request" }, { status: 409 });
    await audit(admin, guard.session, req, { action: `refund.${String(status).toLowerCase()}`, targetType: "refund", targetId: id, merchantId: cur.merchant_id, details: { from: cur.status, amount: cur.amount, note } });
    return NextResponse.json(data);
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
