import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { audit } from "@/lib/audit";
import { isUuid } from "@/lib/settlement";
import { PAID_STATES, authPartner, bad, viewSession } from "@/lib/ride-server";

export const dynamic = "force-dynamic";

const client = () => {
  try {
    return { admin: getAdminClient() };
  } catch (e) {
    if (e instanceof AdminConfigError) return { error: bad("Server misconfigured", 500) };
    throw e;
  }
};

/** The state of one of the partner's rides: OPEN, PAID (with the fee breakdown), CANCELLED or EXPIRED. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return bad("Malformed id");
  const c = client();
  if (!c.admin) return c.error;
  const auth = await authPartner(c.admin, req);
  if (!auth.ok) return auth.res;
  const { data: own } = await c.admin.from("ride_sessions").select("id").eq("id", id).eq("partner_id", auth.partner.id).maybeSingle();
  if (!own) return bad("No such ride", 404);
  return NextResponse.json(await viewSession(c.admin, id), { headers: { "Cache-Control": "no-store" } });
}

/** Cancel a ride that has not been paid (the driver's link stops working). A payment in progress cannot be cancelled. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return bad("Malformed id");
  const c = client();
  if (!c.admin) return c.error;
  const auth = await authPartner(c.admin, req);
  if (!auth.ok) return auth.res;
  const { data: s } = await c.admin.from("ride_sessions").select("id, status").eq("id", id).eq("partner_id", auth.partner.id).maybeSingle();
  if (!s) return bad("No such ride", 404);
  if (s.status === "PAID") return bad("This ride has already been paid.", 409, { code: "ALREADY_PAID" });
  const { data: live } = await c.admin.from("transactions").select("id, status").eq("ride_session_id", id);
  if ((live ?? []).some((t) => t.status === "PROCESSING" || PAID_STATES.includes(t.status as string))) return bad("A payment for this ride is already in progress.", 409, { code: "PAYMENT_IN_PROGRESS" });
  await c.admin.from("ride_sessions").update({ status: "CANCELLED" }).eq("id", id);
  await audit(c.admin, null, req, { action: "ride.session.cancel", targetType: "ride_session", targetId: id, merchantId: auth.partner.merchant_id, details: { partner: auth.partner.name } });
  return NextResponse.json({ session_id: id, status: "CANCELLED" }, { headers: { "Cache-Control": "no-store" } });
}
