import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireMerchant } from "@/lib/guard";
import { OTP_MAX_ATTEMPTS, codeMatches, hashCode, sessionSecret } from "@/lib/auth";
import { STEP_UP_COOKIE, STEP_UP_TTL_S, signStepUp } from "@/lib/settlement-security";
import { audit } from "@/lib/audit";
import { isUuid } from "@/lib/settlement";

export const dynamic = "force-dynamic";

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/**
 * Check the step-up code. On success the browser gets a signed pass (5 minutes, this business, this phone) that the
 * settlement route requires before it accepts a removal, edit or switch of the receiving account.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return bad("Malformed merchant id");
  const guard = await requireMerchant(id, { owner: true });
  if (!guard.ok) return guard.res;
  const secret = sessionSecret();
  if (!secret) return bad("SESSION_SECRET (32+ characters) is not configured", 500);

  const body = await req.json().catch(() => null);
  const challengeId = body?.challenge_id;
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!isUuid(challengeId) || !/^\d{6}$/.test(code)) return bad("Enter the 6-digit code");

  try {
    const admin = getAdminClient();
    const { data: m } = await admin.from("merchants").select("phone").eq("id", id).maybeSingle();
    const { data: ch } = await admin.from("otp_challenges").select("*").eq("id", challengeId).maybeSingle();
    // The challenge must be a step-up challenge for THIS business's registered phone, nothing else.
    if (!m?.phone || !ch || ch.purpose !== "stepup" || ch.phone !== m.phone || ch.consumed_at || new Date(ch.expires_at).getTime() <= Date.now()) return bad("This code has expired. Request a new one.");
    if (ch.attempts >= OTP_MAX_ATTEMPTS) return bad("Too many wrong attempts. Request a new code.", 429);
    if (!codeMatches(ch.code_hash, hashCode(secret, ch.id, ch.phone, code))) {
      await admin.from("otp_challenges").update({ attempts: ch.attempts + 1 }).eq("id", ch.id);
      return bad(`Incorrect code. ${Math.max(0, OTP_MAX_ATTEMPTS - ch.attempts - 1)} attempts left.`);
    }
    const { data: consumed } = await admin.from("otp_challenges").update({ consumed_at: new Date().toISOString() }).eq("id", ch.id).is("consumed_at", null).select("id").maybeSingle();
    if (!consumed) return bad("This code has already been used.");

    const res = NextResponse.json({ ok: true, valid_for_s: STEP_UP_TTL_S });
    res.cookies.set(STEP_UP_COOKIE, signStepUp(id, m.phone, secret), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/api/merchants",
      maxAge: STEP_UP_TTL_S,
    });
    await audit(admin, guard.session, req, { action: "settlement.stepup", targetType: "merchant", targetId: id, merchantId: id });
    return res;
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}