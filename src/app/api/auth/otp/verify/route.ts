import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { OTP_MAX_ATTEMPTS, attachSession, codeMatches, hashCode, sessionSecret } from "@/lib/auth";
import { isUuid } from "@/lib/settlement";
import { findAccountByPhone } from "@/lib/accounts";
import { audit } from "@/lib/audit";
import { hashDevice, hashToken, looksLikeDeviceId, looksLikeInviteToken } from "@/lib/team";
import { APP_REQUIRED_MESSAGE, appRequiredFor } from "@/lib/node-app";

export const dynamic = "force-dynamic";

const CATEGORIES = ["Fuel", "Retail"] as const;
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** Check the code, then either create the merchant account (register) or open a session for it (login). */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const challengeId = body?.challenge_id;
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!isUuid(challengeId) || !/^\d{6}$/.test(code)) return bad("Enter the 6-digit code");
  // Activating a phone needs its device id; say so BEFORE the one-time code is spent.
  if (body?.invite_token !== undefined && !looksLikeDeviceId(body?.device_id)) return bad("This phone could not be identified. Open the link in the 2Pay app or your browser and try again.");

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
      if (body.accepted_terms !== true) return bad("Please accept the Terms of Service and Privacy Policy to register");
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
    let role: "OWNER" | "CASHIER" | "WAITER" = "OWNER";
    let staffId: string | undefined;

    if (ch.purpose === "register") {
      for (let attempt = 0; attempt < 8 && !merchant; attempt++) {
        const terminalId = `TRM-${String(Math.floor(Math.random() * 9000) + 1000)}`;
        const { data, error: insErr } = await admin
          .from("merchants")
          .insert({ business_name: businessName, category, terminal_id: terminalId, phone: ch.phone, phone_verified_at: new Date().toISOString(), terms_accepted_at: new Date().toISOString() })
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
      const account = await findAccountByPhone(admin, ch.phone); // the owner, or a cashier an owner added
      if (!account) return bad("No account for this number. Register first.", 404);
      merchant = { id: account.merchantId, business_name: account.businessName, terminal_id: account.terminalId };
      role = account.role;
      staffId = account.staffId;
      if (appRequiredFor(account.role, req)) return bad(APP_REQUIRED_MESSAGE, 403);

      // Team members are tied to the phone they activated on. The activation link (plus the code sent to the invited
      // number) binds the phone; after that, a different phone is refused until the owner issues a new link.
      if (staffId) {
        const deviceId = looksLikeDeviceId(body.device_id) ? body.device_id : null;
        const invite = looksLikeInviteToken(body.invite_token) ? body.invite_token : null;
        const now = new Date().toISOString();
        if (invite) {
          const { data: m } = await admin
            .from("merchant_staff")
            .select("id, invite_expires_at")
            .eq("id", staffId)
            .eq("invite_token_hash", hashToken(invite))
            .maybeSingle();
          if (!m || new Date(m.invite_expires_at ?? 0).getTime() <= Date.now()) return bad("This activation link has expired or was already used. Ask your manager for a new one.", 410);
          if (!deviceId) return bad("This phone could not be identified. Open the link in the 2Pay app or your browser and try again.");
          await admin
            .from("merchant_staff")
            .update({ activated_at: now, device_id_hash: hashDevice(deviceId), device_label: /android/i.test(req.headers.get("user-agent") ?? "") ? "Android" : /iphone|ipad/i.test(req.headers.get("user-agent") ?? "") ? "iPhone" : "Browser", invite_token_hash: null, invite_expires_at: null, last_seen_at: now })
            .eq("id", staffId);
        } else if (account.deviceHash) {
          if (!deviceId || hashDevice(deviceId) !== account.deviceHash) return bad("This account is linked to another phone. Ask your manager for a new activation link.", 403);
          await admin.from("merchant_staff").update({ last_seen_at: now }).eq("id", staffId);
        } else if (deviceId) {
          // First sign-in of someone added before activation links existed (or whose link was not used): the phone they
          // sign in on, with a code sent to their own number, becomes their linked phone.
          await admin.from("merchant_staff").update({ activated_at: now, device_id_hash: hashDevice(deviceId), last_seen_at: now }).eq("id", staffId);
        }
      }
    }

    const res = NextResponse.json({ merchant, role, created: ch.purpose === "register" });
    await attachSession(res, merchant.id, ch.phone, secret, role, staffId);
    await audit(admin, { mid: merchant.id, ph: ch.phone, rl: role, exp: 0 }, req, { action: ch.purpose === "register" ? "account.register" : body.invite_token ? "team.activate" : "auth.login", targetType: staffId ? "staff" : "merchant", targetId: staffId ?? merchant.id });
    return res;
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}
