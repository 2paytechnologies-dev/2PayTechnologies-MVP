import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/guard";
import { isUuid } from "@/lib/settlement";
import { audit } from "@/lib/audit";
import { newApiKey } from "@/lib/ride";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };
const err = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

/**
 * Ride-hailing partners (Feres, RIDE, ...) and their API keys. A key is shown ONCE, when it is made or rotated; only its hash is
 * kept. A partner's rides land in the ledger of the merchant it is attached to.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  try {
    const admin = getAdminClient();
    const { data, error } = await admin.from("ride_partners").select("id, name, merchant_id, key_hint, active, created_at, last_used_at, merchants(business_name, terminal_id)").order("created_at", { ascending: false }).limit(200);
    if (error) return err("Could not load partners. Has supabase/v2_5.sql been run?", 500);
    const rows = (data ?? []).map((p) => {
      const m = Array.isArray(p.merchants) ? p.merchants[0] : p.merchants;
      const { merchants: _m, ...rest } = p;
      void _m;
      return { ...rest, business: m?.business_name ?? "", terminal: m?.terminal_id ?? "" };
    });
    return NextResponse.json(rows, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof AdminConfigError) return err("Server misconfigured", 500);
    throw e;
  }
}

/** { name, merchant_id } -> the new partner and its API key (once). */
export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
  if (name.length < 2) return err("Give the partner a name", 400);
  if (!isUuid(body?.merchant_id)) return err("Choose the merchant this partner's rides are recorded under", 400);
  try {
    const admin = getAdminClient();
    const { data: m } = await admin.from("merchants").select("id, business_name").eq("id", body.merchant_id).maybeSingle();
    if (!m) return err("That merchant does not exist", 404);
    const k = newApiKey();
    const { data, error } = await admin.from("ride_partners").insert({ name, merchant_id: m.id, key_hash: k.hash, key_hint: k.hint }).select("id").single();
    if (error || !data) return err("Could not create the partner. Has supabase/v2_5.sql been run?", 500);
    await audit(admin, guard.session, req, { action: "ride.partner.create", targetType: "ride_partner", targetId: data.id, merchantId: m.id, details: { name } });
    return NextResponse.json({ id: data.id, name, merchant: m.business_name, api_key: k.key }, { status: 201, headers: NO_STORE });
  } catch (e) {
    if (e instanceof AdminConfigError) return err("Server misconfigured", 500);
    throw e;
  }
}

/** { id, active } turns a partner on or off at once; { id, rotate: true } replaces its key (the old one stops working) and shows the new one once. */
export async function PATCH(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  const body = await req.json().catch(() => null);
  if (!isUuid(body?.id)) return err("Malformed id", 400);
  try {
    const admin = getAdminClient();
    const { data: p } = await admin.from("ride_partners").select("id, name, merchant_id").eq("id", body.id).maybeSingle();
    if (!p) return err("Partner not found", 404);
    if (body.rotate === true) {
      const k = newApiKey();
      const { error } = await admin.from("ride_partners").update({ key_hash: k.hash, key_hint: k.hint }).eq("id", p.id);
      if (error) return err("Could not rotate the key", 500);
      await audit(admin, guard.session, req, { action: "ride.partner.rotate", targetType: "ride_partner", targetId: p.id, merchantId: p.merchant_id, details: { name: p.name } });
      return NextResponse.json({ id: p.id, api_key: k.key }, { headers: NO_STORE });
    }
    if (typeof body.active !== "boolean") return err("active must be true or false", 400);
    const { error } = await admin.from("ride_partners").update({ active: body.active }).eq("id", p.id);
    if (error) return err("Could not update the partner", 500);
    await audit(admin, guard.session, req, { action: body.active ? "ride.partner.enable" : "ride.partner.disable", targetType: "ride_partner", targetId: p.id, merchantId: p.merchant_id, details: { name: p.name } });
    return NextResponse.json({ id: p.id, active: body.active }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof AdminConfigError) return err("Server misconfigured", 500);
    throw e;
  }
}
