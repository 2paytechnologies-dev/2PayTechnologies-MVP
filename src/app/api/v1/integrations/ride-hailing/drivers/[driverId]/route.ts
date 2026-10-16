import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { audit } from "@/lib/audit";
import { isRideId } from "@/lib/ride";
import { authPartner, bad, driverStoredAccounts } from "@/lib/ride-server";

export const dynamic = "force-dynamic";

const client = () => {
  try {
    return { admin: getAdminClient() };
  } catch (e) {
    if (e instanceof AdminConfigError) return { error: bad("Server misconfigured", 500) };
    throw e;
  }
};

/** Is this driver ready for rides? { driver_id, status: NONE | INVITED | PENDING | ACTIVE | REVOKED, ready } (ready = linked AND has an account to be paid into). */
export async function GET(req: Request, { params }: { params: Promise<{ driverId: string }> }) {
  const { driverId } = await params;
  if (!isRideId(driverId)) return bad("Malformed driver id");
  const c = client();
  if (!c.admin) return c.error;
  const auth = await authPartner(c.admin, req);
  if (!auth.ok) return auth.res;
  const { data } = await c.admin.from("ride_driver_links").select("status, merchant_id").eq("partner_id", auth.partner.id).eq("driver_ref", driverId).maybeSingle();
  const status = data?.status ?? "NONE";
  let ready = false;
  if (status === "ACTIVE" && data?.merchant_id) ready = (await driverStoredAccounts(c.admin, data.merchant_id as string)).ok;
  return NextResponse.json({ driver_id: driverId, status, ready }, { headers: { "Cache-Control": "no-store" } });
}

/** The company unlinks a driver (rides for them stop at once). The driver's 2Pay account and any other company links are untouched. */
export async function DELETE(req: Request, { params }: { params: Promise<{ driverId: string }> }) {
  const { driverId } = await params;
  if (!isRideId(driverId)) return bad("Malformed driver id");
  const c = client();
  if (!c.admin) return c.error;
  const auth = await authPartner(c.admin, req);
  if (!auth.ok) return auth.res;
  const { data } = await c.admin.from("ride_driver_links").select("id, status").eq("partner_id", auth.partner.id).eq("driver_ref", driverId).maybeSingle();
  if (!data || data.status === "REVOKED") return bad("No such link", 404);
  await c.admin.from("ride_driver_links").update({ status: "REVOKED", revoked_at: new Date().toISOString() }).eq("id", data.id);
  await audit(c.admin, null, req, { action: "ride.driver.unlink", targetType: "ride_partner", targetId: auth.partner.id, merchantId: auth.partner.merchant_id, details: { partner: auth.partner.name, driver: driverId, by: "company" } });
  return NextResponse.json({ driver_id: driverId, status: "REVOKED" }, { headers: { "Cache-Control": "no-store" } });
}
