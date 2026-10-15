import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { authEnforced, sessionSecret } from "@/lib/auth";
import { requireMerchant, requireSession } from "@/lib/guard";
import { isUuid } from "@/lib/settlement";
import { audit, clientIp } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";
import { sealField } from "@/lib/fieldcrypt";
import { EKYC_TTL_S, EkycError, ekycGateway, normalizeFan } from "@/lib/fayda-ekyc";

export const dynamic = "force-dynamic";

const bad = (error: string, status = 400, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status });

/**
 * Step 1 of the owner's Fayda e-KYC: { fan } -> the national ID service texts a one-time code to the phone linked to that FAN.
 * Returns { fayda_session_id } to send back with the code. Only the business owner can do this, for their own business.
 * (In open test mode there is no session, so the body names the business: { fan, merchant_id }.)
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const s = await requireSession();
  if (!s.ok) return s.res;
  const merchantId = s.session?.mid ?? (authEnforced() ? null : body?.merchant_id);
  if (!isUuid(merchantId)) return bad("Which business? (merchant_id is required)");
  const guard = await requireMerchant(merchantId, { owner: true });
  if (!guard.ok) return guard.res;

  const fan = normalizeFan(body?.fan);
  if (!fan) return bad("Enter your 16-digit Fayda number (FAN).");
  const gateway = ekycGateway();
  if (!gateway) return bad("National ID verification is not switched on yet.", 503, { code: "FAYDA_NOT_CONFIGURED" });
  if (!sessionSecret()) return bad("SESSION_SECRET (32+ characters) is not configured", 500);

  try {
    const admin = getAdminClient();
    // Every request sends a text message from the national ID service: limit it per network and per business.
    if (!(await rateLimit(admin, `fayda:ip:${clientIp(req)}`, 10, 600, { failClosed: true })) || !(await rateLimit(admin, `fayda:m:${merchantId}`, 5, 3600, { failClosed: true }))) {
      return bad("Too many attempts. Please try again later.", 429);
    }
    const { data: m } = await admin.from("merchants").select("fayda_verified").eq("id", merchantId).maybeSingle();
    if (!m) return bad("Business not found", 404);
    if (m.fayda_verified) return bad("This business owner is already verified.", 409, { code: "FAYDA_ALREADY_VERIFIED" });

    const started = await gateway.initiate(fan);
    const { data: row, error } = await admin
      .from("fayda_sessions")
      .insert({ merchant_id: merchantId, fan_enc: sealField(fan, "national-id"), gateway_ref: started.ref, expires_at: new Date(Date.now() + EKYC_TTL_S * 1000).toISOString() })
      .select("id")
      .single();
    if (error || !row) {
      console.error("[fayda initiate] session:", error?.message);
      return bad("Could not start the verification. Has the latest SQL in supabase/ been run?", 500);
    }
    await audit(admin, guard.session, req, { action: "kyc.fayda.initiate", targetType: "merchant", targetId: merchantId, merchantId, details: { fan_last4: fan.slice(-4) } });
    return NextResponse.json({ fayda_session_id: row.id, expires_in: EKYC_TTL_S, phone_hint: started.phoneHint }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof EkycError) return bad(e.message, e.status);
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}
