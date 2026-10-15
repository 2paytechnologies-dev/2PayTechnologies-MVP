import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { authEnforced, sessionSecret } from "@/lib/auth";
import { requireMerchant, requireSession } from "@/lib/guard";
import { isUuid } from "@/lib/settlement";
import { audit, clientIp } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";
import { sealField, tryOpenField } from "@/lib/fieldcrypt";
import { EKYC_MAX_ATTEMPTS, EkycError, ekycGateway, fanHash, normalizeFan } from "@/lib/fayda-ekyc";

export const dynamic = "force-dynamic";

const bad = (error: string, status = 400, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status });

/**
 * Step 2: { fayda_session_id, otp } -> the national ID service checks the code. On success the owner is marked verified, which is
 * what unlocks taking live payments: the name Fayda attests is kept (encrypted), the FAN is kept encrypted, and a keyed hash of the
 * FAN is kept to recognise the same person across businesses. The national ID number itself is not kept.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const s = await requireSession();
  if (!s.ok) return s.res;
  const sid = body?.fayda_session_id;
  const otp = typeof body?.otp === "string" ? body.otp.trim() : "";
  if (!isUuid(sid)) return bad("Malformed verification id");
  if (!/^\d{4,8}$/.test(otp)) return bad("Enter the code you received.");
  const gateway = ekycGateway();
  if (!gateway) return bad("National ID verification is not switched on yet.", 503, { code: "FAYDA_NOT_CONFIGURED" });
  const secret = sessionSecret();
  if (!secret) return bad("SESSION_SECRET (32+ characters) is not configured", 500);

  try {
    const admin = getAdminClient();
    if (!(await rateLimit(admin, `fayda:verify:${clientIp(req)}`, 30, 600, { failClosed: true }))) return bad("Too many attempts. Please try again later.", 429);

    const { data: fs } = await admin.from("fayda_sessions").select("id, merchant_id, fan_enc, gateway_ref, attempts, expires_at, consumed_at").eq("id", sid).maybeSingle();
    // The request must belong to the caller's own business (the session names it; an admin may act for anyone).
    const merchantId = fs?.merchant_id ?? (authEnforced() ? null : body?.merchant_id);
    if (!isUuid(merchantId)) return bad("This verification has expired. Start again.", 400, { code: "FAYDA_SESSION_INVALID" });
    const guard = await requireMerchant(merchantId, { owner: true });
    if (!guard.ok) return guard.res;
    if (!fs || fs.consumed_at || !fs.fan_enc || new Date(fs.expires_at).getTime() <= Date.now()) return bad("This verification has expired. Start again.", 400, { code: "FAYDA_SESSION_INVALID" });
    if (fs.attempts >= EKYC_MAX_ATTEMPTS) return bad("Too many wrong codes. Start again.", 429, { code: "FAYDA_TOO_MANY" });

    // Count the attempt before asking, so a slow or repeated guess cannot get extra tries.
    await admin.from("fayda_sessions").update({ attempts: fs.attempts + 1 }).eq("id", fs.id);

    const fan = tryOpenField(fs.fan_enc as string, "national-id");
    if (!fan || !normalizeFan(fan)) return bad("This verification can no longer be completed. Start again.", 400, { code: "FAYDA_SESSION_INVALID" });
    const result = await gateway.verify(fan, fs.gateway_ref as string, otp);
    if (!result.ok) return bad(`Incorrect code. ${Math.max(0, EKYC_MAX_ATTEMPTS - fs.attempts - 1)} attempts left.`, 400, { code: "FAYDA_WRONG_CODE" });

    // Spend the request first (first writer wins), erase the FAN from it, then record the verification.
    const { data: spent } = await admin.from("fayda_sessions").update({ consumed_at: new Date().toISOString(), fan_enc: null }).eq("id", fs.id).is("consumed_at", null).select("id").maybeSingle();
    if (!spent) return bad("This verification was already used.", 409);

    const at = new Date().toISOString();
    const { error } = await admin
      .from("merchants")
      .update({
        fayda_verified: true,
        fayda_verification_timestamp: at,
        fayda_verified_at: at, // the older column the live-payment gate and the OIDC flow read
        fayda_transaction_id: result.ref,
        fayda_fan: sealField(fan, "national-id"),
        fayda_subject_hash: fanHash(fan, secret),
        fayda_name: result.name ? sealField(result.name, "national-id") : null,
      })
      .eq("id", merchantId);
    if (error) {
      console.error("[fayda verify] update:", error.message);
      return bad("Verified, but we could not save it. Please try again.", 500);
    }
    await audit(admin, guard.session, req, { action: "kyc.fayda.verified", targetType: "merchant", targetId: merchantId, merchantId, details: { fan_last4: fan.slice(-4), transaction: result.ref } });
    return NextResponse.json({ verified: true, name: result.name }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof EkycError) return bad(e.message, e.status);
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}
