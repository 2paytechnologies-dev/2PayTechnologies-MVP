import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";
import { hashLinkCode, normalizeLinkCode } from "@/lib/ride";
import { requireDriver } from "@/lib/driver-server";

export const dynamic = "force-dynamic";

const err = (error: string, status: number, code?: string) => NextResponse.json({ error, ...(code ? { code } : {}) }, { status, headers: { "Cache-Control": "no-store" } });

/**
 * The driver types the code their ride-hailing company showed them: { code: "ABCD-EFGH" }. Typing it proves the driver means the link and the
 * code proves the company does, so the link becomes active at once. A driver can link to several companies; one company's id for a driver
 * can be linked to only one 2Pay driver at a time. Guesses are rate limited.
 */
export async function POST(req: Request) {
  const who = await requireDriver();
  if (!who.ok) return who.res;
  const code = normalizeLinkCode((await req.json().catch(() => null))?.code);
  if (!code) return err("That code does not look right. It is 8 letters and numbers, like ABCD-EFGH.", 400, "CODE_INVALID");
  try {
    const admin = getAdminClient();
    if (!(await rateLimit(admin, `ride:redeem:${who.merchantId}`, 10, 600, { failClosed: true }))) return err("Too many tries. Wait a few minutes.", 429);
    const { data: row } = await admin.from("ride_link_codes").select("id, partner_id, driver_ref, expires_at, used_at").eq("code_hash", hashLinkCode(code)).maybeSingle();
    if (!row || row.used_at || new Date(row.expires_at as string).getTime() <= Date.now()) return err("That code is wrong, already used, or expired. Ask the company for a new one.", 400, "CODE_INVALID");
    const { data: partner } = await admin.from("ride_partners").select("id, name, active, merchant_id").eq("id", row.partner_id).maybeSingle();
    if (!partner?.active) return err("That company is not active on 2Pay.", 409, "PARTNER_INACTIVE");

    const { data: existing } = await admin.from("ride_driver_links").select("id, status, merchant_id").eq("partner_id", row.partner_id).eq("driver_ref", row.driver_ref).maybeSingle();
    if (existing?.status === "ACTIVE" && existing.merchant_id && existing.merchant_id !== who.merchantId) return err("This driver id is already linked to another 2Pay driver. The company must unlink it first.", 409, "DRIVER_ALREADY_LINKED");

    const now = new Date().toISOString();
    const link = { merchant_id: who.merchantId, status: "ACTIVE", confirmed_at: now, revoked_at: null as string | null };
    const { error } = existing ? await admin.from("ride_driver_links").update(link).eq("id", existing.id) : await admin.from("ride_driver_links").insert({ partner_id: row.partner_id, driver_ref: row.driver_ref, ...link });
    if (error) return err("Could not link. Please try again.", 500);
    await admin.from("ride_link_codes").update({ used_at: now }).eq("id", row.id).is("used_at", null);
    await audit(admin, who.session, req, { action: "ride.driver.linked", targetType: "ride_partner", targetId: partner.id as string, merchantId: who.merchantId, details: { partner: partner.name, driver: row.driver_ref, via: "code" } });
    return NextResponse.json({ ok: true, company: partner.name }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AdminConfigError) return err("Server misconfigured", 500);
    throw e;
  }
}
