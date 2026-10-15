import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireMerchant } from "@/lib/guard";
import { sessionSecret } from "@/lib/auth";
import { isUuid } from "@/lib/settlement";
import { audit } from "@/lib/audit";
import { tryOpenField } from "@/lib/fieldcrypt";
import { sendKeyChangedSms } from "@/lib/sms";
import { PIN_RE, hashPin, isWeakPin, resolveApprover } from "@/lib/vault";
import { bad, consumeChallenge, faydaFanOnRecord } from "@/lib/vault-server";
import { EKYC_MAX_ATTEMPTS, EkycError, ekycGateway } from "@/lib/fayda-ekyc";

export const dynamic = "force-dynamic";

/**
 * Finish the forgotten-key check: { challenge_id, code, pin, fayda_session_id?, fayda_otp? }. The code from the registered phone must be right,
 * and for an owner verified with Fayda so must the code from the Fayda-linked phone. Only then is the new 6-digit key stored (as a hash), the
 * wrong-key count and lock cleared, and the person and the owner texted. It does NOT open the vault: changing an account still needs the new
 * key and a fresh code, so this check can never by itself move money anywhere.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return bad("Malformed merchant id");
  const guard = await requireMerchant(id, { vault: true });
  if (!guard.ok) return guard.res;
  const secret = sessionSecret();
  if (!secret) return bad("SESSION_SECRET (32+ characters) is not configured", 500);

  const body = await req.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  const pin = typeof body?.pin === "string" ? body.pin : "";
  const faydaOtp = typeof body?.fayda_otp === "string" ? body.fayda_otp.trim() : "";
  if (!isUuid(body?.challenge_id) || !/^\d{6}$/.test(code)) return bad("Enter the 6-digit code sent to your phone");
  if (!PIN_RE.test(pin)) return bad("The security key is 6 digits");
  if (isWeakPin(pin)) return bad("That key is too easy to guess. Choose another 6 digits.");

  try {
    const admin = getAdminClient();
    const a = await resolveApprover(admin, id, guard.session);
    if (!a || !a.phone) return bad("Only the owner or a manager can manage payment accounts", 403);
    if (!a.hasPin) return bad("No security key has been chosen yet. Choose one instead.", 409, { code: "VAULT_NO_PIN" });
    const fanRecorded = await faydaFanOnRecord(admin, a, id);

    // Fayda first, if it applies and was started: it must be present and right before anything is consumed.
    let faydaSessionId: string | null = null;
    if (fanRecorded) {
      if (!isUuid(body?.fayda_session_id) || !/^\d{4,8}$/.test(faydaOtp)) return bad("Enter the code from your Fayda phone.", 400, { code: "FAYDA_REQUIRED" });
      const gateway = ekycGateway();
      if (!gateway) return bad("National ID verification is not switched on.", 503, { code: "FAYDA_NOT_CONFIGURED" });
      const { data: fs } = await admin.from("fayda_sessions").select("id, merchant_id, fan_enc, gateway_ref, attempts, expires_at, consumed_at").eq("id", body.fayda_session_id).maybeSingle();
      if (!fs || fs.merchant_id !== id || fs.consumed_at || !fs.fan_enc || new Date(fs.expires_at).getTime() <= Date.now()) return bad("The Fayda check expired. Start again.", 400, { code: "FAYDA_SESSION_INVALID" });
      if (fs.attempts >= EKYC_MAX_ATTEMPTS) return bad("Too many wrong Fayda codes. Start again.", 429, { code: "FAYDA_TOO_MANY" });
      await admin.from("fayda_sessions").update({ attempts: fs.attempts + 1 }).eq("id", fs.id);
      const fan = tryOpenField(fs.fan_enc as string, "national-id");
      if (!fan || fan !== fanRecorded) return bad("The Fayda check expired. Start again.", 400, { code: "FAYDA_SESSION_INVALID" });
      const res = await ekycGateway()!.verify(fan, fs.gateway_ref as string, faydaOtp);
      if (!res.ok) return bad(`Incorrect Fayda code. ${Math.max(0, EKYC_MAX_ATTEMPTS - fs.attempts - 1)} attempts left.`, 400, { code: "FAYDA_WRONG_CODE" });
      faydaSessionId = fs.id as string;
    }

    const wrong = await consumeChallenge(admin, body.challenge_id, code, a.phone, secret);
    if (wrong) return wrong;
    if (faydaSessionId) await admin.from("fayda_sessions").update({ consumed_at: new Date().toISOString(), fan_enc: null }).eq("id", faydaSessionId).is("consumed_at", null);

    const { error } = await admin
      .from(a.table)
      .update({ vault_pin_hash: await hashPin(pin), vault_pin_set_at: new Date().toISOString(), vault_failed: 0, vault_locked_until: null })
      .eq("id", a.id);
    if (error) {
      console.error("[vault reset]", error.message);
      return bad("Could not save the new security key", 500);
    }
    await audit(admin, guard.session, req, { action: "vault.key_reset.self", targetType: a.table === "merchants" ? "merchant" : "staff", targetId: a.id, merchantId: id, details: { approver: a.kind, fayda_checked: !!fanRecorded } });

    // Tell the person and the owner (the same phone when it is the owner's own key), so a change nobody expected is noticed at once.
    const [{ data: m }, { data: staff }] = await Promise.all([
      admin.from("merchants").select("business_name, phone").eq("id", id).maybeSingle(),
      a.kind === "MANAGER" ? admin.from("merchant_staff").select("name").eq("id", a.id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    const business = m?.business_name ?? "your business";
    const who = a.kind === "OWNER" ? "the owner" : ((staff as { name?: string } | null)?.name ?? "a manager");
    await Promise.all([...new Set([a.phone, m?.phone].filter((p): p is string => !!p))].map((p) => sendKeyChangedSms(p, business, who)));

    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof EkycError) return bad(e.message, e.status);
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}
