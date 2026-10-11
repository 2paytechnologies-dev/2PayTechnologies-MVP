import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { OTP_MAX_ATTEMPTS, attachSession, codeMatches, hashCode, sessionSecret } from "@/lib/auth";
import { isUuid } from "@/lib/settlement";

export const dynamic = "force-dynamic";

const CATEGORIES = ["Fuel", "Retail"] as const;
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** Check the code, then either create the merchant account (register) or open a session for it (login). */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const challengeId = body?.challenge_id;
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!isUuid(challengeId) || !/^\d{6}$/.test(code)) return bad("Enter the 6-digit code");

  const secret = sessionSecret();
  if (!secret) return bad("SESSION_SECRET (32+ characters) is not configured", 500);

  try {
    const admin = getAdminClient();
    const { data: ch, error } = await admin.from("otp_challenges").select("*").eq("id", challengeId).maybeSingle();
    if (error) return bad("Could not verify the code", 500);
    if (!ch || ch.consumed_at || new Date(ch.expires_at).getTime() <= Date.now()) return bad("This code has expired. Request a new one.");
    if (ch.attempts >= OTP_MAX_ATTEMPTS) return bad("Too many wrong attempts. Request a new code.", 429);

    // Validate registration details BEFORE spending the code, so a typo doesn't force a resend.
    let businessName = "";
    let category: (typeof CATEGORIES)[number] = "Retail";
    if (ch.purpose === "register") {
      businessName = typeof body.business_name === "string" ? body.business_name.trim() : "";
      if (businessName.length < 2 || businessName.length > 80) return bad("Business name must be 2–80 characters");
      if (!CATEGORIES.includes(body.category)) return bad("Choose Fuel or Retail");
      category = body.category;
    }

    if (!codeMatches(ch.code_hash, hashCode(secret, ch.id, ch.phone, code))) {
      await admin.from("otp_challenges").update({ attempts: ch.attempts + 1 }).eq("id", ch.id);
      return bad(`Incorrect code. ${Math.max(0, OTP_MAX_ATTEMPTS - ch.attempts - 1)} attempts left.`);
    }

    // Single-use: only one concurrent request can flip consumed_at from null.
    const { data: consumed } = await admin
      .from("otp_challenges")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", ch.id)
      .is("consumed_at", null)
      .select("id")
      .maybeSingle();
    if (!consumed) return bad("This code has already been used.");

    let merchant: { id: string; business_name: string; terminal_id: string } | null = null;

    if (ch.purpose === "register") {
      for (let attempt = 0; attempt < 8 && !merchant; attempt++) {
        const terminalId = `TRM-${String(Math.floor(Math.random() * 9000) + 1000)}`;
        const { data, error: insErr } = await admin
          .from("merchants")
          .insert({ business_name: businessName, category, terminal_id: terminalId, phone: ch.phone, phone_verified_at: new Date().toISOString() })
          .select("id, business_name, terminal_id")
          .single();
        if (!insErr) merchant = data;
        else if (insErr.code === "23505" && insErr.message.includes("phone")) return bad("This number is already registered. Sign in instead.", 409);
        else if (insErr.code !== "23505") {
          console.error("[otp/verify] create merchant:", insErr.message);
          return bad("Could not create the account", 500);
        } // else: terminal id collision, retry with a new one
      }
      if (!merchant) return bad("Could not allocate a terminal ID. Please try again.", 500);
    } else {
      const { data } = await admin.from("merchants").select("id, business_name, terminal_id").eq("phone", ch.phone).maybeSingle();
      if (!data) return bad("No account for this number. Register first.", 404);
      merchant = data;
    }

    const res = NextResponse.json({ merchant, created: ch.purpose === "register" });
    await attachSession(res, merchant.id, ch.phone, secret);
    return res;
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}
