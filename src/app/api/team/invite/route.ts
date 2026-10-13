import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { clientIp } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";
import { hashToken, inviteIsLive, looksLikeInviteToken } from "@/lib/team";

export const dynamic = "force-dynamic";

/**
 * What the activation page shows before the person has proven who they are: the business, their name and team number.
 * It reveals nothing else (no phone number, no money details), and an unknown, used or expired link all look the same.
 */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  if (!looksLikeInviteToken(token)) return NextResponse.json({ valid: false }, { status: 400 });
  try {
    const admin = getAdminClient();
    if (!(await rateLimit(admin, `invite:ip:${clientIp(req)}`, 30, 600, { failClosed: true }))) {
      return NextResponse.json({ error: "Too many attempts. Try again in a few minutes." }, { status: 429 });
    }
    const { data: m } = await admin
      .from("merchant_staff")
      .select("name, role, team_no, invite_expires_at, merchants(business_name)")
      .eq("invite_token_hash", hashToken(token))
      .eq("active", true)
      .maybeSingle();
    if (!m || !inviteIsLive(m.invite_expires_at)) return NextResponse.json({ valid: false }, { status: 410 });
    const merchant = (Array.isArray(m.merchants) ? m.merchants[0] : m.merchants) as { business_name: string } | null;
    return NextResponse.json({ valid: true, business_name: merchant?.business_name ?? "", name: m.name, role: m.role, team_no: m.team_no });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
