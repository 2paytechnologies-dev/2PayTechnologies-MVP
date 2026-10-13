import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireMerchant } from "@/lib/guard";
import { normalizePhone } from "@/lib/auth";
import { isUuid } from "@/lib/settlement";
import { audit } from "@/lib/audit";
import { sendSms, smsConfigured } from "@/lib/sms";
import { MAX_TEAM, STAFF_ROLES, hashToken, inviteExpiry, memberStatus, newInviteToken, nextTeamNo, type StaffRole } from "@/lib/team";
import { inviteSms, siteOrigin } from "@/lib/team-invite";

export const dynamic = "force-dynamic";

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });
const mask = (phone: string) => `${phone.slice(0, 7)}•••${phone.slice(-2)}`;

/** The owner's team: waiters and cashiers, with their team number, state and (for the owner only) nothing secret. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return bad("Malformed merchant id");
  const guard = await requireMerchant(id, { owner: true });
  if (!guard.ok) return guard.res;
  try {
    const { data, error } = await getAdminClient()
      .from("merchant_staff")
      .select("id, phone, name, role, team_no, active, activated_at, invite_expires_at, device_label, last_seen_at, created_at")
      .eq("merchant_id", id)
      .eq("active", true)
      .order("created_at");
    if (error) return bad("Could not load your team", 500);
    return NextResponse.json(
      (data ?? []).map(({ phone, invite_expires_at, ...s }) => ({ ...s, phone_masked: mask(phone), status: memberStatus({ activated_at: s.activated_at, invite_expires_at }), invite_expires_at })),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}

/** Pick the next team number and insert, retrying if two requests raced for the same number. */
async function insertMember(admin: SupabaseClient, row: Record<string, unknown>, role: StaffRole, merchantId: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: used } = await admin.from("merchant_staff").select("team_no").eq("merchant_id", merchantId); // includes removed members: numbers are never reused
    const teamNo = nextTeamNo(role, (used ?? []).map((u) => u.team_no as string | null));
    const res = await admin.from("merchant_staff").insert({ ...row, team_no: teamNo }).select("id, name, role, team_no, created_at").single();
    if (!res.error || !(res.error.code === "23505" && /team_no/.test(res.error.message))) return res;
  }
  return { data: null, error: { code: "23505", message: "team_no" } } as const;
}

/**
 * Add a team member. They get a team number (W-001, C-001 ...) and a one-time activation link, valid for 72 hours.
 * The link is returned once and texted to them if SMS is configured; only its hash is stored. To sign in they must also
 * receive a code on the number the owner entered, so a forwarded link alone opens nothing.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return bad("Malformed merchant id");
  const guard = await requireMerchant(id, { owner: true });
  if (!guard.ok) return guard.res;

  const body = await req.json().catch(() => null);
  const phone = normalizePhone(body?.phone);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const role: StaffRole = STAFF_ROLES.includes(body?.role) ? body.role : "WAITER";
  if (!phone) return bad("Enter a valid Ethiopian mobile number, e.g. 0911223344");
  if (name.length < 2 || name.length > 60) return bad("Enter the person's name (2–60 characters)");

  try {
    const admin = getAdminClient();
    const [{ data: owner }, { data: staff }, { count }] = await Promise.all([
      admin.from("merchants").select("id").eq("phone", phone).maybeSingle(),
      admin.from("merchant_staff").select("id").eq("phone", phone).eq("active", true).maybeSingle(),
      admin.from("merchant_staff").select("id", { count: "exact", head: true }).eq("merchant_id", id).eq("active", true),
    ]);
    if (owner || staff) return bad("That number already has a 2Pay account", 409);
    if ((count ?? 0) >= MAX_TEAM) return bad(`A team can have up to ${MAX_TEAM} people`, 409);

    const token = newInviteToken();
    const { data, error } = await insertMember(admin, { merchant_id: id, phone, name, role, invite_token_hash: hashToken(token), invite_expires_at: inviteExpiry(), invited_at: new Date().toISOString() }, role, id);
    if (error || !data) {
      console.error("[staff POST]", error?.message);
      return bad(error?.code === "23505" ? "That number already has a 2Pay account" : "Could not add the team member", error?.code === "23505" ? 409 : 500);
    }

    const link = `${siteOrigin(req)}/join/${token}`;
    let smsSent = false;
    if (smsConfigured()) {
      const { data: m } = await admin.from("merchants").select("business_name").eq("id", id).maybeSingle();
      smsSent = await sendSms(phone, inviteSms({ business: m?.business_name ?? "Your business", teamNo: data.team_no, role, link }));
    }
    await audit(admin, guard.session, req, { action: "staff.add", targetType: "staff", targetId: data.id, merchantId: id, details: { name, role, team_no: data.team_no, phone_last4: phone.slice(-4) } });
    return NextResponse.json({ ...data, phone_masked: mask(phone), status: "INVITED", invite_link: link, invite_expires_at: inviteExpiry(), sms_sent: smsSent }, { status: 201 });
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}
