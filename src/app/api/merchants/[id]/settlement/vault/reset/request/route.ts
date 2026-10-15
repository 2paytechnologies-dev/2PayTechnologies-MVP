import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireMerchant } from "@/lib/guard";
import { sessionSecret } from "@/lib/auth";
import { isUuid } from "@/lib/settlement";
import { clientIp } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";
import { maskPhone, resolveApprover } from "@/lib/vault";
import { bad, faydaFanOnRecord, issueChallenge } from "@/lib/vault-server";

export const dynamic = "force-dynamic";

/**
 * Forgot your security key? Step one of the forgotten-key check: a one-time code to the phone registered for this person. For an owner who
 * verified with Fayda, the answer also says a Fayda check follows (their FAN and a code to the phone linked to it). 2Pay staff are not involved
 * and nothing is shown or recoverable: the old key is replaced by a new one the person chooses. Works while the key is locked, too.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return bad("Malformed merchant id");
  const guard = await requireMerchant(id, { vault: true });
  if (!guard.ok) return guard.res;
  const secret = sessionSecret();
  if (!secret) return bad("SESSION_SECRET (32+ characters) is not configured", 500);

  try {
    const admin = getAdminClient();
    if (!(await rateLimit(admin, `vaultreset:ip:${clientIp(req)}`, 12, 600, { failClosed: true })) || !(await rateLimit(admin, `vaultreset:m:${id}`, 8, 3600, { failClosed: true }))) {
      return bad("Too many attempts. Try again in a little while.", 429);
    }
    const a = await resolveApprover(admin, id, guard.session);
    if (!a) return bad("Only the owner or a manager can manage payment accounts", 403);
    if (!a.hasPin) return bad("No security key has been chosen yet. Choose one instead.", 409, { code: "VAULT_NO_PIN" });
    if (!a.phone) return bad("There is no phone on record to send a code to. Contact 2Pay support.", 409);

    const c = await issueChallenge(admin, a.phone, secret);
    if (!c.ok) return c.res;
    const fan = await faydaFanOnRecord(admin, a, id);
    return NextResponse.json({ challenge_id: c.challengeId, phone_masked: maskPhone(a.phone), fayda_check: !!fan, ...(c.devCode ? { dev_code: c.devCode } : {}) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}
