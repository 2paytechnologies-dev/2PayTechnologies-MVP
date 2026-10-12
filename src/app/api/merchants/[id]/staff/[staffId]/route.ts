import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireMerchant } from "@/lib/guard";
import { isUuid } from "@/lib/settlement";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** Remove a cashier. Their phone stops working immediately; the row is kept (inactive) for the audit trail. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; staffId: string }> }) {
  const { id, staffId } = await params;
  if (!isUuid(id) || !isUuid(staffId)) return NextResponse.json({ error: "Malformed id" }, { status: 400 });
  const guard = await requireMerchant(id, { owner: true });
  if (!guard.ok) return guard.res;
  try {
    const admin = getAdminClient();
    const { data, error } = await admin.from("merchant_staff").update({ active: false }).eq("id", staffId).eq("merchant_id", id).eq("active", true).select("id, name");
    if (error) return NextResponse.json({ error: "Could not remove the cashier" }, { status: 500 });
    if (!data?.length) return NextResponse.json({ error: "Cashier not found" }, { status: 404 });
    await audit(admin, guard.session, req, { action: "staff.remove", targetType: "staff", targetId: staffId, merchantId: id, details: { name: data[0].name } });
    return NextResponse.json({ removed: true });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
