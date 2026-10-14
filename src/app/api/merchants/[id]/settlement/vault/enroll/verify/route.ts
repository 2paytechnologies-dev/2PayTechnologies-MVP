import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireMerchant } from "@/lib/guard";
import { normalizePhone, sessionSecret } from "@/lib/auth";
import { isUuid } from "@/lib/settlement";
import { audit } from "@/lib/audit";
import { PIN_RE, hashPin, isWeakPin, resolveApprover } from "@/lib/vault";
import { bad, consumeChallenge, withPass } from "@/lib/vault-server";

export const dynamic = "force-dynamic";

/** Step two: the code from the phone, plus the new 6-digit security key. Sets the key (and the phone, if there was none) and opens the vault for a few minutes. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return bad("Malformed merchant id");
  const guard = await requireMerchant(id, { vault: true });
  if (!guard.ok) return guard.res;
  const secret = sessionSecret();
  if (!secret) return bad("SESSION_SECRET (32+ characters) is not configured", 500);

  const body = await req.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  const pin = typeof body?.pin === "string" ? body.pin : "";
  if (!isUuid(body?.challenge_id) || !/^\d{6}$/.test(code)) return bad("Enter the 6-digit code");
  if (!PIN_RE.test(pin)) return bad("The security key is 6 digits");
  if (isWeakPin(pin)) return bad("That key is too easy to guess. Choose another 6 digits.");

  try {
    const admin = getAdminClient();
    const a = await resolveApprover(admin, id, guard.session);
    if (!a) return bad("Only the owner or a manager can manage payment accounts", 403);
    if (a.hasPin) return bad("A security key is already set. To change it, contact 2Pay support.", 409, { code: "VAULT_PIN_EXISTS" });

    const phone = a.phone ?? normalizePhone(body?.phone);
    if (!phone) return bad("Enter the mobile number that will receive security codes");
    const wrong = await consumeChallenge(admin, body.challenge_id, code, phone, secret);
    if (wrong) return wrong;

    const update = { vault_pin_hash: await hashPin(pin), vault_pin_set_at: new Date().toISOString(), vault_failed: 0, vault_locked_until: null, ...(a.phone ? {} : { phone, phone_verified_at: new Date().toISOString() }) };
    const { error } = await admin.from(a.table).update(update).eq("id", a.id).is("vault_pin_hash", null);
    if (error) {
      console.error("[vault enroll]", error.message);
      return bad(error.code === "23505" ? "That number already has a 2Pay account" : "Could not save the security key", error.code === "23505" ? 409 : 500);
    }
    await audit(admin, guard.session, req, { action: "vault.enroll", targetType: a.table === "merchants" ? "merchant" : "staff", targetId: a.id, merchantId: id, details: { approver: a.kind, phone_attached: !a.phone } });
    return withPass(NextResponse.json({ ok: true }), id, { ...a, phone }, secret);
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}