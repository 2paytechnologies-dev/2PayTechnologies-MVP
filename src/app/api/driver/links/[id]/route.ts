import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { audit } from "@/lib/audit";
import { isUuid } from "@/lib/settlement";
import { requireDriver } from "@/lib/driver-server";

export const dynamic = "force-dynamic";

const err = (error: string, status: number) => NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

/** Accept or decline a company's request to link: { action: "confirm" | "decline" }. Only the driver the request was made for. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return err("Malformed id", 400);
  const who = await requireDriver();
  if (!who.ok) return who.res;
  const action = (await req.json().catch(() => null))?.action;
  if (action !== "confirm" && action !== "decline") return err("action must be confirm or decline", 400);
  try {
    const admin = getAdminClient();
    const { data: link } = await admin.from("ride_driver_links").select("id, partner_id, driver_ref, status, merchant_id").eq("id", id).maybeSingle();
    if (!link || link.merchant_id !== who.merchantId) return err("No such request", 404);
    if (link.status !== "PENDING") return err("This request is not waiting for an answer.", 409);
    const now = new Date().toISOString();
    const patch = action === "confirm" ? { status: "ACTIVE", confirmed_at: now } : { status: "REVOKED", revoked_at: now };
    await admin.from("ride_driver_links").update(patch).eq("id", id).eq("status", "PENDING");
    await audit(admin, who.session, req, { action: action === "confirm" ? "ride.driver.linked" : "ride.driver.declined", targetType: "ride_partner", targetId: link.partner_id as string, merchantId: who.merchantId, details: { driver: link.driver_ref, via: "request" } });
    return NextResponse.json({ ok: true, status: patch.status }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AdminConfigError) return err("Server misconfigured", 500);
    throw e;
  }
}

/** The driver unlinks a company (rides from it stop at once). Their 2Pay account and other links are untouched. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return err("Malformed id", 400);
  const who = await requireDriver();
  if (!who.ok) return who.res;
  try {
    const admin = getAdminClient();
    const { data: link } = await admin.from("ride_driver_links").select("id, partner_id, driver_ref, status, merchant_id").eq("id", id).maybeSingle();
    if (!link || link.merchant_id !== who.merchantId || link.status === "REVOKED") return err("No such link", 404);
    await admin.from("ride_driver_links").update({ status: "REVOKED", revoked_at: new Date().toISOString() }).eq("id", id);
    await audit(admin, who.session, req, { action: "ride.driver.unlink", targetType: "ride_partner", targetId: link.partner_id as string, merchantId: who.merchantId, details: { driver: link.driver_ref, by: "driver" } });
    return NextResponse.json({ ok: true, status: "REVOKED" }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AdminConfigError) return err("Server misconfigured", 500);
    throw e;
  }
}
