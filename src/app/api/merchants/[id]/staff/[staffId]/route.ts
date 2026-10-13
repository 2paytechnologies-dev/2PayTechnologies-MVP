import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireMerchant } from "@/lib/guard";
import { isUuid } from "@/lib/settlement";
import { audit } from "@/lib/audit";
import { sendSms, smsConfigured } from "@/lib/sms";
import { hashToken, inviteExpiry, newInviteToken, type StaffRole } from "@/lib/team";
import { appLinkFor, inviteSms, siteOrigin } from "@/lib/team-invite";

export const dynamic = "force-dynamic";

/**
 * Issue a new activation link for a team member (lost phone, new phone, expired link). The old link stops working and the
 * phone they were linked to is released, so the next sign-in must come from the phone that opens the new link.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; staffId: string }> }) {
  const { id, staffId } = await params;
  if (!isUuid(id) || !isUuid(staffId)) return NextResponse.json({ error: "Malformed id" }, { status: 400 });
  const guard = await requireMerchant(id, { owner: true });
  if (!guard.ok) return guard.res;
  try {
    const admin = getAdminClient();
    const token = newInviteToken();
    const { data, error } = await admin
      .from("merchant_staff")
      .update({ invite_token_hash: hashToken(token), invite_expires_at: inviteExpiry(), invited_at: new Date().toISOString(), activated_at: null, device_id_hash: null, device_label: null })
      .eq("id", staffId)
      .eq("merchant_id", id)
      .eq("active", true)
      .select("id, name, phone, role, team_no")
      .maybeSingle();
    if (error) return NextResponse.json({ error: "Could not create a new link" }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Team member not found" }, { status: 404 });

    const link = `${siteOrigin(req)}/join/${token}`;
    let smsSent = false;
    if (smsConfigured()) {
      const { data: m } = await admin.from("merchants").select("business_name").eq("id", id).maybeSingle();
      smsSent = await sendSms(data.phone, inviteSms({ business: m?.business_name ?? "Your business", teamNo: data.team_no ?? "", role: data.role as StaffRole, link }));
    }
    await audit(admin, guard.session, req, { action: "staff.reissue", targetType: "staff", targetId: staffId, merchantId: id, details: { name: data.name, team_no: data.team_no } });
    return NextResponse.json({ id: data.id, team_no: data.team_no, status: "INVITED", invite_link: link, app_link: appLinkFor(token), invite_expires_at: inviteExpiry(), sms_sent: smsSent });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}

/** Remove a team member. Their phone stops working immediately; the row is kept (inactive) so past sales still name them. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; staffId: string }> }) {
  const { id, staffId } = await params;
  if (!isUuid(id) || !isUuid(staffId)) return NextResponse.json({ error: "Malformed id" }, { status: 400 });
  const guard = await requireMerchant(id, { owner: true });
  if (!guard.ok) return guard.res;
  try {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from("merchant_staff")
      .update({ active: false, invite_token_hash: null, invite_expires_at: null })
      .eq("id", staffId)
      .eq("merchant_id", id)
      .eq("active", true)
      .select("id, name, team_no");
    if (error) return NextResponse.json({ error: "Could not remove the team member" }, { status: 500 });
    if (!data?.length) return NextResponse.json({ error: "Team member not found" }, { status: 404 });
    await audit(admin, guard.session, req, { action: "staff.remove", targetType: "staff", targetId: staffId, merchantId: id, details: { name: data[0].name, team_no: data[0].team_no } });
    return NextResponse.json({ removed: true });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
