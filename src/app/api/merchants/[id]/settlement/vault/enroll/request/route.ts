import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireMerchant } from "@/lib/guard";
import { normalizePhone, sessionSecret } from "@/lib/auth";
import { isUuid } from "@/lib/settlement";
import { clientIp } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";
import { maskPhone, resolveApprover } from "@/lib/vault";
import { bad, issueChallenge } from "@/lib/vault-server";

export const dynamic = "force-dynamic";

/**
 * Step one of choosing a security key: send a one-time code to the approver's phone. A business that has no registered
 * phone yet supplies one here (and it is only attached after that phone proves it can receive the code). Only available
 * while no key exists; once a key is set it can only be reset by 2Pay support, so a stolen session cannot swap it.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return bad("Malformed merchant id");
  const guard = await requireMerchant(id, { vault: true });
  if (!guard.ok) return guard.res;
  const secret = sessionSecret();
  if (!secret) return bad("SESSION_SECRET (32+ characters) is not configured", 500);
  const body = await req.json().catch(() => null);

  try {
    const admin = getAdminClient();
    if (!(await rateLimit(admin, `vault:ip:${clientIp(req)}`, 12, 600, { failClosed: true }))) return bad("Too many attempts. Try again in a few minutes.", 429);
    const a = await resolveApprover(admin, id, guard.session);
    if (!a) return bad("Only the owner or a manager can manage payment accounts", 403);
    if (a.hasPin) return bad("A security key is already set. To change it, contact 2Pay support.", 409, { code: "VAULT_PIN_EXISTS" });

    let phone = a.phone;
    if (!phone) {
      phone = normalizePhone(body?.phone);
      if (!phone) return bad("Enter the mobile number that will receive security codes, e.g. 0911223344");
      const [{ data: owner }, { data: staff }] = await Promise.all([
        admin.from("merchants").select("id").eq("phone", phone).maybeSingle(),
        admin.from("merchant_staff").select("id").eq("phone", phone).eq("active", true).maybeSingle(),
      ]);
      if (owner || staff) return bad("That number already has a 2Pay account", 409);
    }
    const c = await issueChallenge(admin, phone, secret);
    if (!c.ok) return c.res;
    return NextResponse.json({ challenge_id: c.challengeId, phone_masked: maskPhone(phone), delivered: c.delivered, ...(c.devCode ? { dev_code: c.devCode } : {}) });
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}