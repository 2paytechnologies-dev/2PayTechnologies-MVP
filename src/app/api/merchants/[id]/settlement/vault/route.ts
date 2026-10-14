import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireMerchant } from "@/lib/guard";
import { isUuid } from "@/lib/settlement";
import { isLocked, maskPhone, minutesLeft, resolveApprover } from "@/lib/vault";

export const dynamic = "force-dynamic";

/** What the "Confirm it's you" screen needs to know: which step comes next. Nothing secret. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "Malformed merchant id" }, { status: 400 });
  const guard = await requireMerchant(id, { vault: true });
  if (!guard.ok) return guard.res;
  try {
    const a = await resolveApprover(getAdminClient(), id, guard.session);
    if (!a) return NextResponse.json({ error: "Only the owner or a manager can manage payment accounts" }, { status: 403 });
    return NextResponse.json({
      approver: a.kind,
      has_phone: !!a.phone,
      has_pin: a.hasPin,
      phone_masked: a.phone ? maskPhone(a.phone) : null,
      locked_minutes: isLocked(a.lock) ? minutesLeft(a.lock) : 0,
    });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}