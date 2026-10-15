import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { OTP_MAX_ATTEMPTS, OTP_MAX_REQUESTS, OTP_REQUEST_WINDOW_S, OTP_TTL_S, codeMatches, hashCode, newCode, testMode } from "@/lib/auth";
import { sendStepUpSms, smsConfigured } from "@/lib/sms";
import { STEP_UP_COOKIE, STEP_UP_TTL_S, signStepUp } from "@/lib/settlement-security";
import { type Approver } from "@/lib/vault";
import { tryOpenField } from "@/lib/fieldcrypt";
import { ekycMode } from "@/lib/fayda-ekyc";

/** The shared pieces of the vault routes: sending the one-time code, checking it, and issuing the pass. */

export const bad = (error: string, status = 400, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status });

export type Challenge = { ok: true; challengeId: string; delivered: boolean; devCode?: string } | { ok: false; res: NextResponse };

/** Send a step-up code to `phone`. Rate limited per phone; fails closed when SMS is not configured outside test mode. */
export async function issueChallenge(admin: SupabaseClient, phone: string, secret: string): Promise<Challenge> {
  if (!testMode() && !smsConfigured()) return { ok: false, res: bad("SMS delivery is not configured", 503) };
  const since = new Date(Date.now() - OTP_REQUEST_WINDOW_S * 1000).toISOString();
  const { count } = await admin.from("otp_challenges").select("id", { count: "exact", head: true }).eq("phone", phone).eq("purpose", "stepup").gte("created_at", since);
  if ((count ?? 0) >= OTP_MAX_REQUESTS) return { ok: false, res: bad("Too many codes requested. Try again in a few minutes.", 429) };

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
    console.error("[vault challenge]", error.message);
    return { ok: false, res: bad("Could not start the security check. Has the latest SQL in supabase/ been run?", 500) };
  }
  const delivered = await sendStepUpSms(phone, code);
  if (!delivered && !testMode()) {
    await admin.from("otp_challenges").delete().eq("id", challengeId);
    return { ok: false, res: bad("Could not send the SMS. Please try again.", 502) };
  }
  return { ok: true, challengeId, delivered, ...(testMode() ? { devCode: code } : {}) };
}

/** Check a step-up code for this phone and spend it. Returns an error response, or null when the code was right. */
export async function consumeChallenge(admin: SupabaseClient, challengeId: string, code: string, phone: string, secret: string): Promise<NextResponse | null> {
  const { data: ch } = await admin.from("otp_challenges").select("*").eq("id", challengeId).maybeSingle();
  if (!ch || ch.purpose !== "stepup" || ch.phone !== phone || ch.consumed_at || new Date(ch.expires_at).getTime() <= Date.now()) return bad("This code has expired. Request a new one.");
  if (ch.attempts >= OTP_MAX_ATTEMPTS) return bad("Too many wrong attempts. Request a new code.", 429);
  if (!codeMatches(ch.code_hash, hashCode(secret, ch.id, ch.phone, code))) {
    await admin.from("otp_challenges").update({ attempts: ch.attempts + 1 }).eq("id", ch.id);
    return bad(`Incorrect code. ${Math.max(0, OTP_MAX_ATTEMPTS - ch.attempts - 1)} attempts left.`);
  }
  const { data: consumed } = await admin.from("otp_challenges").update({ consumed_at: new Date().toISOString() }).eq("id", ch.id).is("consumed_at", null).select("id").maybeSingle();
  return consumed ? null : bad("This code has already been used.");
}

/** Attach the short-lived pass: this business, this approver, this phone. */
export function withPass(res: NextResponse, merchantId: string, a: Approver & { phone: string }, secret: string): NextResponse {
  res.cookies.set(STEP_UP_COOKIE, signStepUp(merchantId, a.id, a.phone, secret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api/merchants",
    maxAge: STEP_UP_TTL_S,
  });
  return res;
}
/**
 * The Fayda FAN the owner verified with, or null when the forgotten-key check cannot include Fayda (the approver is not the owner, no
 * Fayda gateway is connected, or the owner verified another way and no FAN is on record). Decrypted on the server only, to compare with
 * what the person types: it never goes into a response.
 */
export async function faydaFanOnRecord(admin: SupabaseClient, approver: Approver, merchantId: string): Promise<string | null> {
  if (approver.kind !== "OWNER" || !ekycMode()) return null;
  const { data } = await admin.from("merchants").select("fayda_fan, fayda_verified").eq("id", merchantId).maybeSingle();
  if (!data?.fayda_verified || !data.fayda_fan) return null;
  return tryOpenField(data.fayda_fan as string, "national-id");
}