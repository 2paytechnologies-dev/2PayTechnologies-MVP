import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireMerchant } from "@/lib/guard";
import { isUuid } from "@/lib/settlement";
import { clientIp } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";
import { sealField } from "@/lib/fieldcrypt";
import { resolveApprover } from "@/lib/vault";
import { bad, faydaFanOnRecord } from "@/lib/vault-server";
import { EKYC_TTL_S, EkycError, ekycGateway, normalizeFan } from "@/lib/fayda-ekyc";

export const dynamic = "force-dynamic";

/**
 * The Fayda half of the forgotten-key check, for an owner who verified with Fayda: { fan }. The FAN must be the one the owner verified with
 * (a different person's FAN is refused before any code is sent), then the national ID service texts a code to the phone linked to it.
 * Five tries an hour per business, so the FAN cannot be guessed.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return bad("Malformed merchant id");
  const guard = await requireMerchant(id, { vault: true });
  if (!guard.ok) return guard.res;
  const body = await req.json().catch(() => null);
  const fan = normalizeFan(body?.fan);
  if (!fan) return bad("Enter your 16-digit Fayda number (FAN).");
  const gateway = ekycGateway();
  if (!gateway) return bad("National ID verification is not switched on.", 503, { code: "FAYDA_NOT_CONFIGURED" });

  try {
    const admin = getAdminClient();
    if (!(await rateLimit(admin, `vaultreset:fan:${id}`, 5, 3600, { failClosed: true })) || !(await rateLimit(admin, `vaultreset:fanip:${clientIp(req)}`, 10, 600, { failClosed: true }))) {
      return bad("Too many attempts. Try again in a little while.", 429);
    }
    const a = await resolveApprover(admin, id, guard.session);
    if (!a || !a.hasPin) return bad("Only the owner or a manager can manage payment accounts", 403);
    const onRecord = await faydaFanOnRecord(admin, a, id);
    if (!onRecord) return bad("A Fayda check does not apply here.", 409);
    const same = onRecord.length === fan.length && timingSafeEqual(Buffer.from(onRecord), Buffer.from(fan));
    if (!same) return bad("That is not the Fayda number this business was verified with.", 400, { code: "FAYDA_MISMATCH" });

    const started = await gateway.initiate(fan);
    const { data: row, error } = await admin
      .from("fayda_sessions")
      .insert({ merchant_id: id, fan_enc: sealField(fan, "national-id"), gateway_ref: started.ref, expires_at: new Date(Date.now() + EKYC_TTL_S * 1000).toISOString() })
      .select("id")
      .single();
    if (error || !row) return bad("Could not start the Fayda check", 500);
    return NextResponse.json({ fayda_session_id: row.id, phone_hint: started.phoneHint }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof EkycError) return bad(e.message, e.status);
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}
