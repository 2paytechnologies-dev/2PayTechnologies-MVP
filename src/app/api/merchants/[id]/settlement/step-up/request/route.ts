import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireMerchant } from "@/lib/guard";
import { OTP_MAX_REQUESTS, OTP_REQUEST_WINDOW_S, OTP_TTL_S, hashCode, newCode, sessionSecret, testMode } from "@/lib/auth";
import { sendStepUpSms, smsConfigured } from "@/lib/sms";
import { isUuid } from "@/lib/settlement";
import { clientIp } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/**
 * Start a step-up check before the receiving account is changed. The code goes ONLY to the phone number registered on
 * the business: the request carries no phone number, so there is nothing an attacker can point it at. Owner only.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return bad("Malformed merchant id");
  const guard = await requireMerchant(id, { owner: true });
  if (!guard.ok) return guard.res;
  const secret = sessionSecret();
  if (!secret) return bad("SESSION_SECRET (32+ characters) is not configured", 500);
  if (!testMode() && !smsConfigured()) return bad("SMS delivery is not configured", 503);

  try {
    const admin = getAdminClient();
    if (!(await rateLimit(admin, `stepup:ip:${clientIp(req)}`, 12, 600, { failClosed: true }))) return bad("Too many attempts. Try again in a few minutes.", 429);

    const { data: m } = await admin.from("merchants").select("phone").eq("id", id).maybeSingle();
    const phone = m?.phone as string | null | undefined;
    if (!phone) return bad("This business has no registered phone number to send the code to.", 409);

    const since = new Date(Date.now() - OTP_REQUEST_WINDOW_S * 1000).toISOString();
    const { count } = await admin.from("otp_challenges").select("id", { count: "exact", head: true }).eq("phone", phone).eq("purpose", "stepup").gte("created_at", since);
    if ((count ?? 0) >= OTP_MAX_REQUESTS) return bad("Too many codes requested. Try again in a few minutes.", 429);

    const challengeId = randomUUID();
    const code = newCode();
    const { error } = await admin.from("otp_challenges").insert({
      id: challengeId,
      phone,
      purpose: "stepup",
      code_hash: hashCode(secret, challengeId, phone, code),
      expires_at: new Date(Date.now() + OTP_TTL_S * 1000).toISOString(),
    });
    if (error) {
      console.error("[stepup request]", error.message);
      return bad("Could not start the security check. Has the latest SQL in supabase/ been run?", 500);
    }
    const delivered = await sendStepUpSms(phone, code);
    if (!delivered && !testMode()) {
      await admin.from("otp_challenges").delete().eq("id", challengeId);
      return bad("Could not send the SMS. Please try again.", 502);
    }
    return NextResponse.json({
      challenge_id: challengeId,
      phone_masked: `${phone.slice(0, 7)}•••${phone.slice(-2)}`,
      expires_in: OTP_TTL_S,
      delivered,
      ...(testMode() ? { dev_code: code } : {}),
    });
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}