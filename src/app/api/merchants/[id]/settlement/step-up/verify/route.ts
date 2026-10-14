import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireMerchant } from "@/lib/guard";
import { sessionSecret } from "@/lib/auth";
import { STEP_UP_TTL_S } from "@/lib/settlement-security";
import { audit } from "@/lib/audit";
import { isUuid } from "@/lib/settlement";
import { resolveApprover } from "@/lib/vault";
import { bad, consumeChallenge, withPass } from "@/lib/vault-server";

export const dynamic = "force-dynamic";

/**
 * Unlock the vault, step two: the one-time code. On success the browser gets a signed pass (3 minutes; this business, this
 * approver, this phone) that the settlement route requires before it accepts any add, edit or removal of a receiving account.
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
  if (!isUuid(body?.challenge_id) || !/^\d{6}$/.test(code)) return bad("Enter the 6-digit code");

  try {
    const admin = getAdminClient();
    const a = await resolveApprover(admin, id, guard.session);
    if (!a?.phone || !a.hasPin) return bad("Set up your security key first.", 403, { code: "VAULT_SETUP_REQUIRED" });
    // The challenge must be a step-up challenge for THIS approver's registered phone, nothing else.
    const wrong = await consumeChallenge(admin, body.challenge_id, code, a.phone, secret);
    if (wrong) return wrong;
    await audit(admin, guard.session, req, { action: "settlement.stepup", targetType: a.table === "merchants" ? "merchant" : "staff", targetId: a.id, merchantId: id, details: { approver: a.kind } });
    return withPass(NextResponse.json({ ok: true, valid_for_s: STEP_UP_TTL_S }), id, { ...a, phone: a.phone }, secret);
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}