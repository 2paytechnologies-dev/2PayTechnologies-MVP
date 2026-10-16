import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/guard";
import { isUuid, normalizeWalletNumber } from "@/lib/settlement";
import { audit } from "@/lib/audit";
import { newApiKey } from "@/lib/ride";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };
const err = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

/**
 * Ride-hailing companies (Feres, RIDE, ...) and their API keys. A company is registered here on its own: it is NOT a merchant and never
 * appears in the merchant list. Registering it creates a ledger record of kind RIDE_PARTNER for its rides (no phone, so nobody can sign in
 * as it, and no shop QR). The API key is shown ONCE, when it is made or rotated; only its hash is kept.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  try {
    const admin = getAdminClient();
    const { data, error } = await admin.from("ride_partners").select("id, name, key_hint, active, allow_partner_accounts, contact_name, contact_phone, created_at, last_used_at").order("created_at", { ascending: false }).limit(200);
    if (error) return err("Could not load companies. Has supabase/v2_7.sql been run?", 500);
    return NextResponse.json(data ?? [], { headers: NO_STORE });
  } catch (e) {
    if (e instanceof AdminConfigError) return err("Server misconfigured", 500);
    throw e;
  }
}

/** { name, contact_name?, contact_phone? } -> the registered company and its API key (once). */
export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
  if (name.length < 2) return err("Give the company a name", 400);
  const contactName = typeof body?.contact_name === "string" ? body.contact_name.trim().slice(0, 80) : "";
  const rawPhone = typeof body?.contact_phone === "string" ? body.contact_phone.trim() : "";
  const contactPhone = rawPhone ? normalizeWalletNumber(rawPhone) : null;
  if (rawPhone && !contactPhone) return err("The contact number does not look right. Use a mobile number like 0911223344.", 400);
  try {
    const admin = getAdminClient();
    // The company's own ledger record: kind RIDE_PARTNER, no phone, verified because an admin registered it after checking its documents.
    let merchantId: string | null = null;
    for (let i = 0; i < 5 && !merchantId; i++) {
      const terminal = `RIDE-${randomBytes(3).toString("hex").toUpperCase()}`;
      const { data, error } = await admin
        .from("merchants")
        .insert({ business_name: name, category: "Retail", terminal_id: terminal, kind: "RIDE_PARTNER", kyc_status: "VERIFIED", kyc_note: "Registered by 2Pay admin", kyc_reviewed_at: new Date().toISOString(), static_qr_enabled: false })
        .select("id")
        .single();
      if (data) merchantId = data.id;
      else if (error && error.code !== "23505") return err("Could not register the company. Has supabase/v2_6.sql been run?", 500);
    }
    if (!merchantId) return err("Could not register the company", 500);
    const k = newApiKey();
    const { data, error } = await admin
      .from("ride_partners")
      .insert({ name, merchant_id: merchantId, key_hash: k.hash, key_hint: k.hint, contact_name: contactName || null, contact_phone: contactPhone })
      .select("id")
      .single();
    if (error || !data) {
      await admin.from("merchants").delete().eq("id", merchantId); // do not leave a half-registered company behind
      return err("Could not register the company", 500);
    }
    await audit(admin, guard.session, req, { action: "ride.partner.create", targetType: "ride_partner", targetId: data.id, merchantId, details: { name } });
    return NextResponse.json({ id: data.id, name, api_key: k.key }, { status: 201, headers: NO_STORE });
  } catch (e) {
    if (e instanceof AdminConfigError) return err("Server misconfigured", 500);
    throw e;
  }
}

/** { id, allow_partner_accounts } allows or stops the legacy mode where the company sends driver accounts itself; { id, active } turns a company on or off at once; { id, rotate: true } replaces its key (the old one stops working) and shows the new one once. */
export async function PATCH(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  const body = await req.json().catch(() => null);
  if (!isUuid(body?.id)) return err("Malformed id", 400);
  try {
    const admin = getAdminClient();
    const { data: p } = await admin.from("ride_partners").select("id, name, merchant_id").eq("id", body.id).maybeSingle();
    if (!p) return err("Company not found", 404);
    if (body.rotate === true) {
      const k = newApiKey();
      const { error } = await admin.from("ride_partners").update({ key_hash: k.hash, key_hint: k.hint }).eq("id", p.id);
      if (error) return err("Could not rotate the key", 500);
      await audit(admin, guard.session, req, { action: "ride.partner.rotate", targetType: "ride_partner", targetId: p.id, merchantId: p.merchant_id, details: { name: p.name } });
      return NextResponse.json({ id: p.id, api_key: k.key }, { headers: NO_STORE });
    }
    if (typeof body.allow_partner_accounts === "boolean") {
      // Legacy mode: the company may send a driver's payout accounts with each ride. Off by default; drivers keep their own accounts in 2Pay.
      const { error } = await admin.from("ride_partners").update({ allow_partner_accounts: body.allow_partner_accounts }).eq("id", p.id);
      if (error) return err("Could not update the company", 500);
      await audit(admin, guard.session, req, { action: body.allow_partner_accounts ? "ride.partner.accounts.allow" : "ride.partner.accounts.deny", targetType: "ride_partner", targetId: p.id, merchantId: p.merchant_id, details: { name: p.name } });
      return NextResponse.json({ id: p.id, allow_partner_accounts: body.allow_partner_accounts }, { headers: NO_STORE });
    }
    if (typeof body.active !== "boolean") return err("active must be true or false", 400);
    const { error } = await admin.from("ride_partners").update({ active: body.active }).eq("id", p.id);
    if (error) return err("Could not update the company", 500);
    await audit(admin, guard.session, req, { action: body.active ? "ride.partner.enable" : "ride.partner.disable", targetType: "ride_partner", targetId: p.id, merchantId: p.merchant_id, details: { name: p.name } });
    return NextResponse.json({ id: p.id, active: body.active }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof AdminConfigError) return err("Server misconfigured", 500);
    throw e;
  }
}
