import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireMerchant } from "@/lib/guard";
import { isUuid } from "@/lib/settlement";
import { maskTin, validateProfile } from "@/lib/kyc";
import { audit } from "@/lib/audit";
import { sealField, tryOpenField } from "@/lib/fieldcrypt";
import { faydaConfigured } from "@/lib/fayda";

export const dynamic = "force-dynamic";

const COLUMNS = "legal_name, tin, business_license, address, location, kyc_status, kyc_note, kyc_submitted_at, kyc_reviewed_at, static_qr_enabled, sms_receipts, fayda_verified_at, fayda_name";
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** The TIN is shown masked; the full number never leaves the server again after it is submitted. */
function view(row: Record<string, unknown>) {
  const { tin, fayda_name, ...rest } = row;
  return {
    ...rest,
    tin_masked: maskTin(tryOpenField(tin as string | null, "tin")),
    has_tin: !!tin,
    // The owner's own national-ID check: whether the provider is set up, whether it is required, and who it verified.
    fayda: { configured: faydaConfigured(), required: process.env.KYC_REQUIRE_FAYDA === "true", name: tryOpenField(fayda_name as string | null, "national-id") },
  };
}

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return bad("Malformed merchant id");
  const guard = await requireMerchant(id, { owner: true });
  if (!guard.ok) return guard.res;
  try {
    const { data, error } = await getAdminClient().from("merchants").select(COLUMNS).eq("id", id).maybeSingle();
    if (error) {
      console.error("[profile GET]", error.message);
      return bad("Could not load the business profile", 500);
    }
    if (!data) return bad("Merchant not found", 404);
    return NextResponse.json(view(data), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}

/**
 * Submit business details for verification, or change the shop preferences (scan-to-pay, SMS receipts).
 * Submitting details moves the status to SUBMITTED for an admin to review. A VERIFIED business that edits its
 * legal details goes back to SUBMITTED, so a verification can't be reused for different details.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return bad("Malformed merchant id");
  const guard = await requireMerchant(id, { owner: true });
  if (!guard.ok) return guard.res;
  const body = await req.json().catch(() => null);
  if (!body) return bad("Invalid JSON");

  const update: Record<string, unknown> = {};
  if (typeof body.static_qr_enabled === "boolean") update.static_qr_enabled = body.static_qr_enabled;
  if (typeof body.sms_receipts === "boolean") update.sms_receipts = body.sms_receipts;

  const submitting = body.legal_name !== undefined || body.tin !== undefined || body.business_license !== undefined || body.address !== undefined;
  if (submitting) {
    // A TIN left blank means "keep the one on file": the full number is never sent back to the browser.
    let tin = body.tin;
    if (tin === undefined || tin === "") {
      const { data: cur } = await getAdminClient().from("merchants").select("tin").eq("id", id).maybeSingle();
      tin = tryOpenField(cur?.tin, "tin") ?? undefined; // stored encrypted; opened only here, on the server, to be checked again
    }
    const v = validateProfile({ ...body, tin });
    if (!v.ok) return bad(v.error);
    Object.assign(update, v.profile, { kyc_status: "SUBMITTED", kyc_submitted_at: new Date().toISOString(), kyc_reviewed_at: null, kyc_note: null });
    if (typeof update.tin === "string") update.tin = sealField(update.tin, "tin"); // encrypted at rest
  }
  if (!Object.keys(update).length) return bad("Nothing to update");

  try {
    const admin = getAdminClient();
    const { data, error } = await admin.from("merchants").update(update).eq("id", id).select(COLUMNS).single();
    if (error) {
      console.error("[profile PUT]", error.message);
      return bad("Could not save", 500);
    }
    await audit(admin, guard.session, req, {
      action: submitting ? "kyc.submit" : "profile.preferences",
      targetType: "merchant",
      targetId: id,
      merchantId: id,
      details: submitting ? { legal_name: update.legal_name } : { static_qr_enabled: update.static_qr_enabled, sms_receipts: update.sms_receipts },
    });
    return NextResponse.json(view(data));
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}
