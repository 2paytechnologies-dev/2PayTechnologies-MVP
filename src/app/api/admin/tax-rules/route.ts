import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { DEFAULT_TAX_RULES, resolveRules, validateRules } from "@/lib/tax";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };
const err = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE });

/**
 * The tax rules the estimate uses. The defaults are the long-standing Ethiopian rates but are NOT confirmed against current law: changing the
 * rules starts a new version that is unconfirmed, and an administrator marks a version confirmed once a tax adviser has checked it. Merchants
 * are told on screen whether the rules behind their estimate are confirmed.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  try {
    const { data, error } = await getAdminClient().from("tax_settings").select("rules, version, confirmed_by, confirmed_at, updated_at").eq("id", 1).maybeSingle();
    if (error) return err("Could not load the tax rules. Has supabase/v2_7.sql been run?", 500);
    return NextResponse.json(
      { rules: resolveRules(data?.rules), defaults: DEFAULT_TAX_RULES, version: data?.version ?? 1, confirmed_by: data?.confirmed_by ?? null, confirmed_at: data?.confirmed_at ?? null, updated_at: data?.updated_at ?? null },
      { headers: NO_STORE },
    );
  } catch (e) {
    if (e instanceof AdminConfigError) return err("Server misconfigured", 500);
    throw e;
  }
}

/** { rules } saves a new version (unconfirmed). */
export async function PUT(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  const body = await req.json().catch(() => null);
  const v = validateRules(body?.rules);
  if (!v.ok) return err(v.error, 400);
  try {
    const admin = getAdminClient();
    const { data: cur } = await admin.from("tax_settings").select("version").eq("id", 1).maybeSingle();
    const version = Number(cur?.version ?? 1) + 1;
    const { error } = await admin.from("tax_settings").upsert({ id: 1, rules: v.rules, version, confirmed_by: null, confirmed_at: null, updated_at: new Date().toISOString() });
    if (error) return err("Could not save the tax rules", 500);
    await audit(admin, guard.session, req, { action: "tax.rules.update", targetType: "tax_settings", targetId: "1", details: { version, vat: v.rules.vat.rate, threshold: v.rules.vat.threshold } });
    return NextResponse.json({ ok: true, version }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof AdminConfigError) return err("Server misconfigured", 500);
    throw e;
  }
}

/** { confirm: true, version, name } marks that exact version confirmed by a named person. A stale version is refused so a newer edit is never confirmed unseen. */
export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
  if (body?.confirm !== true || name.length < 2) return err("Give the name of the person who checked these rules", 400);
  try {
    const admin = getAdminClient();
    const { data: cur } = await admin.from("tax_settings").select("version").eq("id", 1).maybeSingle();
    const version = Number(cur?.version ?? 1);
    if (Number(body.version) !== version) return err("The rules changed since you opened this page. Reload and check them again.", 409);
    // The defaults may never have been saved: store them, so what was confirmed is exactly what is on record.
    const { data: row } = await admin.from("tax_settings").select("rules").eq("id", 1).maybeSingle();
    const { error } = await admin.from("tax_settings").upsert({ id: 1, rules: resolveRules(row?.rules), version, confirmed_by: name, confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    if (error) return err("Could not confirm the tax rules", 500);
    await audit(admin, guard.session, req, { action: "tax.rules.confirm", targetType: "tax_settings", targetId: "1", details: { version, confirmed_by: name } });
    return NextResponse.json({ ok: true, version }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof AdminConfigError) return err("Server misconfigured", 500);
    throw e;
  }
}
