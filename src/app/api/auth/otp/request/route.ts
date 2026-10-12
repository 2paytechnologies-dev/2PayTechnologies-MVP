import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { OTP_MAX_REQUESTS, OTP_REQUEST_WINDOW_S, OTP_TTL_S, hashCode, newCode, normalizePhone, sessionSecret, testMode } from "@/lib/auth";
import { sendOtpSms, smsConfigured } from "@/lib/sms";
import { findAccountByPhone } from "@/lib/accounts";
import { clientIp } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/**
 * Start phone verification for registration or sign-in.
 * TEST MODE (AUTH_ENFORCED unset): the code is also returned as `dev_code` because no SMS provider is wired yet.
 * ENFORCED MODE: the code is only ever delivered by SMS; without a configured gateway this fails closed with 503.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const phone = normalizePhone(body?.phone);
  const purpose = body?.purpose;
  if (!phone) return NextResponse.json({ error: "Enter a valid Ethiopian mobile number, e.g. 0911223344" }, { status: 400 });
  if (purpose !== "register" && purpose !== "login") return NextResponse.json({ error: "purpose must be 'register' or 'login'" }, { status: 400 });

  const secret = sessionSecret();
  if (!secret) return NextResponse.json({ error: "SESSION_SECRET (32+ characters) is not configured" }, { status: 500 });
  if (!testMode() && !smsConfigured()) return NextResponse.json({ error: "SMS delivery is not configured" }, { status: 503 });

  try {
    const admin = getAdminClient();

    // Abuse guard: each code costs an SMS, so limit per IP as well as per phone (fails closed).
    if (!(await rateLimit(admin, `otp:ip:${clientIp(req)}`, 12, 600, { failClosed: true }))) {
      return NextResponse.json({ error: "Too many attempts. Try again in a few minutes." }, { status: 429 });
    }

    let existing;
    try {
      existing = await findAccountByPhone(admin, phone); // an owner OR a cashier added by an owner
    } catch (e) {
      console.error("[otp/request] account lookup:", (e as Error).message);
      return NextResponse.json({ error: "Could not start verification. Has the latest SQL in supabase/ been run?" }, { status: 500 });
    }
    if (purpose === "register" && existing) return NextResponse.json({ error: "This number is already registered. Sign in instead." }, { status: 409 });
    if (purpose === "login" && !existing) return NextResponse.json({ error: "No account for this number. Register first." }, { status: 404 });

    const since = new Date(Date.now() - OTP_REQUEST_WINDOW_S * 1000).toISOString();
    const { count } = await admin.from("otp_challenges").select("id", { count: "exact", head: true }).eq("phone", phone).gte("created_at", since);
    if ((count ?? 0) >= OTP_MAX_REQUESTS) {
      return NextResponse.json({ error: "Too many codes requested. Try again in a few minutes." }, { status: 429 });
    }

    const id = randomUUID();
    const code = newCode();
    const { error } = await admin.from("otp_challenges").insert({
      id,
      phone,
      purpose,
      code_hash: hashCode(secret, id, phone, code),
      expires_at: new Date(Date.now() + OTP_TTL_S * 1000).toISOString(),
    });
    if (error) {
      console.error("[otp/request] insert:", error.message);
      return NextResponse.json({ error: "Could not start verification" }, { status: 500 });
    }

    const delivered = await sendOtpSms(phone, code);
    if (!delivered && !testMode()) {
      await admin.from("otp_challenges").delete().eq("id", id);
      return NextResponse.json({ error: "Could not send the SMS. Please try again." }, { status: 502 });
    }

    return NextResponse.json({
      challenge_id: id,
      phone,
      expires_in: OTP_TTL_S,
      delivered,
      ...(testMode() ? { dev_code: code } : {}),
    });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
