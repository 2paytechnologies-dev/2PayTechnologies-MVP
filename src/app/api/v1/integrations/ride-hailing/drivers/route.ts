import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { audit } from "@/lib/audit";
import { normalizePhone } from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";
import { sendSms } from "@/lib/sms";
import { isRideId } from "@/lib/ride";
import { authPartner, bad, baseUrlFor } from "@/lib/ride-server";

export const dynamic = "force-dynamic";

/**
 * A ride-hailing company asks to link one of its drivers to their 2Pay account, by phone number:
 *   POST { driver_id, phone }       (driver_id is the company's own id for the driver)
 * - If a driver already registered with 2Pay under that number (category Ride Service), they get a text and accept the company under
 *   "Rides" in the app: status PENDING until they do, then ACTIVE.
 * - If not, they get a text inviting them to install 2Pay and register; the invitation waits (status INVITED) and is offered to them as soon
 *   they register with that number.
 * A driver can be linked to several companies at once. The company never sees or sends the driver's bank or wallet details.
 * To link without a phone number, use POST .../drivers/link-code instead.
 */
export async function POST(req: Request) {
  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
  const auth = await authPartner(admin, req);
  if (!auth.ok) return auth.res;
  const { partner } = auth;
  const body = await req.json().catch(() => null);
  if (!isRideId(body?.driver_id)) return bad("driver_id is required (letters, digits . _ : - , up to 64)", 400, { code: "INVALID_REQUEST" });
  const phone = typeof body?.phone === "string" ? normalizePhone(body.phone) : null;
  if (!phone) return bad("phone is required (a mobile number like 0911223344), or use link-code", 400, { code: "INVALID_REQUEST" });
  const driverRef = body.driver_id as string;

  if (!(await rateLimit(admin, `ride:invite:${phone}`, 3, 3600, { failClosed: true }))) return bad("That number was contacted too many times. Try again later.", 429);

  const [{ data: owner }, { data: existing }] = await Promise.all([
    admin.from("merchants").select("id, kind").eq("phone", phone).maybeSingle(),
    admin.from("ride_driver_links").select("id, status, merchant_id").eq("partner_id", partner.id).eq("driver_ref", driverRef).maybeSingle(),
  ]);
  if (owner && owner.kind !== "DRIVER") return bad("That number belongs to a business account, not a driver.", 409, { code: "NOT_A_DRIVER" });
  const merchantId = (owner?.id as string | undefined) ?? null;

  if (existing?.status === "ACTIVE" && existing.merchant_id && existing.merchant_id !== merchantId) return bad("This driver id is already linked to a different 2Pay driver. Unlink it first.", 409, { code: "DRIVER_ALREADY_LINKED" });
  if (existing?.status === "ACTIVE" && existing.merchant_id === merchantId) return NextResponse.json({ driver_id: driverRef, status: "ACTIVE" }, { headers: { "Cache-Control": "no-store" } });

  const status = merchantId ? "PENDING" : "INVITED";
  const row = { phone, merchant_id: merchantId, status, revoked_at: null as string | null };
  const { error } = existing ? await admin.from("ride_driver_links").update(row).eq("id", existing.id) : await admin.from("ride_driver_links").insert({ partner_id: partner.id, driver_ref: driverRef, ...row });
  if (error) {
    console.error("[ride link]", error.message);
    return bad("Could not create the link. Has the latest SQL in supabase/ (v2_7.sql) been run?", 500);
  }

  const dl = `${baseUrlFor(req)}/download`;
  await sendSms(
    phone,
    merchantId
      ? `2Pay: ${partner.name} wants to link your 2Pay account so passengers can pay you by tap. Open 2Pay > Rides and accept. If you did not expect this, ignore it.\n2Pay፦ ${partner.name} ተሳፋሪዎች በመነካካት እንዲከፍሉዎት የ2Pay አካውንትዎን ማገናኘት ይፈልጋል። 2Pay > ጉዞዎች ውስጥ ይቀበሉ። ያልጠበቁት ከሆነ ችላ ይበሉ።`
      : `${partner.name} invites you to be paid by tap with 2Pay. Install the 2Pay app (${dl}), register as "Ride Service" with this number, then accept ${partner.name} under Rides.\n${partner.name} በ2Pay በመነካካት እንዲከፈሉ ይጋብዝዎታል። የ2Pay መተግበሪያውን ይጫኑ (${dl})፣ በዚህ ቁጥር "የራይድ አገልግሎት" ብለው ይመዝገቡ፣ ከዚያ ጉዞዎች ውስጥ ${partner.name}ን ይቀበሉ።`,
  );
  await audit(admin, null, req, { action: "ride.driver.link", targetType: "ride_partner", targetId: partner.id, merchantId: partner.merchant_id, details: { partner: partner.name, driver: driverRef, status, phone_last4: phone.slice(-4) } });
  return NextResponse.json({ driver_id: driverRef, status }, { status: existing ? 200 : 201, headers: { "Cache-Control": "no-store" } });
}
