import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireMerchant } from "@/lib/guard";
import { sessionSecret } from "@/lib/auth";
import { isUuid } from "@/lib/settlement";
import { audit, clientIp } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";
import { LOCK_MINUTES, MAX_FAILED, afterWrongPin, isLocked, maskPhone, minutesLeft, resolveApprover, verifyPin } from "@/lib/vault";
import { bad, issueChallenge } from "@/lib/vault-server";

export const dynamic = "force-dynamic";

/**
 * Unlock the vault, step one: the approver's security key. Only a correct key makes us send the one-time code (so nobody can
 * run up SMS costs or spam the owner's phone without it). Five wrong keys lock the vault for 15 minutes. The code goes
 * ONLY to the approver's own registered phone; the request carries no phone number, so there is nothing to point it elsewhere.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return bad("Malformed merchant id");
  const guard = await requireMerchant(id, { vault: true });
  if (!guard.ok) return guard.res;
  const secret = sessionSecret();
  if (!secret) return bad("SESSION_SECRET (32+ characters) is not configured", 500);
  const body = await req.json().catch(() => null);
  const pin = typeof body?.pin === "string" ? body.pin : "";

  try {
    const admin = getAdminClient();
    if (!(await rateLimit(admin, `vault:ip:${clientIp(req)}`, 12, 600, { failClosed: true }))) return bad("Too many attempts. Try again in a few minutes.", 429);
    const a = await resolveApprover(admin, id, guard.session);
    if (!a) return bad("Only the owner or a manager can manage payment accounts", 403);
    if (!a.phone || !a.hasPin) return bad("Set up your security key first.", 403, { code: "VAULT_SETUP_REQUIRED", need: !a.phone ? "phone" : "pin" });
    if (isLocked(a.lock)) return bad(`Too many wrong keys. Try again in ${minutesLeft(a.lock)} minutes.`, 423, { code: "VAULT_LOCKED", minutes: minutesLeft(a.lock) });

    const { data: row } = await admin.from(a.table).select("vault_pin_hash").eq("id", a.id).maybeSingle();
    if (!(await verifyPin(pin, row?.vault_pin_hash))) {
      const next = afterWrongPin(a.lock);
      await admin.from(a.table).update({ vault_failed: next.failed, vault_locked_until: next.lockedUntil }).eq("id", a.id);
      await audit(admin, guard.session, req, { action: next.lockedUntil ? "vault.locked" : "vault.key.wrong", targetType: a.table === "merchants" ? "merchant" : "staff", targetId: a.id, merchantId: id, details: { approver: a.kind } });
      if (next.lockedUntil) return bad(`Too many wrong keys. The vault is locked for ${LOCK_MINUTES} minutes.`, 423, { code: "VAULT_LOCKED", minutes: LOCK_MINUTES });
      return bad(`Incorrect security key. ${MAX_FAILED - next.failed} tries left.`, 400, { code: "VAULT_WRONG_KEY" });
    }
    if (a.lock.failed) await admin.from(a.table).update({ vault_failed: 0, vault_locked_until: null }).eq("id", a.id);

    const c = await issueChallenge(admin, a.phone, secret);
    if (!c.ok) return c.res;
    return NextResponse.json({ challenge_id: c.challengeId, phone_masked: maskPhone(a.phone), delivered: c.delivered, ...(c.devCode ? { dev_code: c.devCode } : {}) });
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}