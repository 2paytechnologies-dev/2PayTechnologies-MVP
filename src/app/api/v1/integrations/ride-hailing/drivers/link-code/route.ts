import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { audit } from "@/lib/audit";
import { LINK_CODE_TTL_MS, hashLinkCode, isRideId, newLinkCode, normalizeLinkCode } from "@/lib/ride";
import { authPartner, bad } from "@/lib/ride-server";

export const dynamic = "force-dynamic";

/**
 * A one-time code for linking a driver without a phone number: POST { driver_id } -> { code: "ABCD-EFGH", expires_at }.
 * The company shows the code to the driver (in its own app), and the driver types it into 2Pay under Rides. 30 minutes, once.
 * A new code for the same driver cancels the earlier ones.
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
  const driverRef = body.driver_id as string;

  await admin.from("ride_link_codes").update({ used_at: new Date().toISOString() }).eq("partner_id", partner.id).eq("driver_ref", driverRef).is("used_at", null);
  const { code, hash } = newLinkCode();
  const expires_at = new Date(Date.now() + LINK_CODE_TTL_MS).toISOString();
  const { error } = await admin.from("ride_link_codes").insert({ partner_id: partner.id, driver_ref: driverRef, code_hash: hash, expires_at });
  if (error) return bad("Could not make a code. Has the latest SQL in supabase/ (v2_7.sql) been run?", 500);
  await audit(admin, null, req, { action: "ride.driver.code", targetType: "ride_partner", targetId: partner.id, merchantId: partner.merchant_id, details: { partner: partner.name, driver: driverRef } });
  void hashLinkCode, void normalizeLinkCode;
  return NextResponse.json({ driver_id: driverRef, code, expires_at, instructions: "The driver opens 2Pay > Rides > Link a company and types this code." }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
