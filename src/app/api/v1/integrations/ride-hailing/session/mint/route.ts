import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { clientIp } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";
import { createPayNode } from "@/lib/pay-nodes";
import { sha256, SESSION_TOKEN_RE } from "@/lib/ride";
import { PAID_STATES, bad, sessionByToken, statusOf } from "@/lib/ride-server";
import type { StoredAccount } from "@/lib/fieldcrypt";

export const dynamic = "force-dynamic";

/**
 * The driver's phone, opened with the checkout link, asks for the pay node to broadcast: { session_token }. The fare and the
 * driver's accounts come from the ride (set by the partner), never from the phone. Each call mints a fresh single-use node
 * (/pay/{token}, 90 seconds) for the tap and the QR; the phone asks again shortly before one expires.
 * The link itself is the credential, so it is long, random, kept only as a hash, and expires with the ride.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const token = body?.session_token;
  if (typeof token !== "string" || !SESSION_TOKEN_RE.test(token)) return bad("This checkout link is not valid.", 400, { code: "SESSION_INVALID" });

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
  if (!(await rateLimit(admin, `ride:mint:ip:${clientIp(req)}`, 60, 60, { failClosed: true })) || !(await rateLimit(admin, `ride:mint:${sha256(token).slice(0, 16)}`, 40, 60, { failClosed: true }))) {
    return bad("Too many attempts. Please wait a moment.", 429);
  }

  const s = await sessionByToken(admin, token);
  if (!s) return bad("This checkout link is not valid.", 404, { code: "SESSION_INVALID" });
  const state = statusOf(s);
  if (state === "CANCELLED") return bad("This ride was cancelled.", 410, { code: "SESSION_CANCELLED" });
  if (state === "EXPIRED") return bad("This checkout link has expired. Ask for a new one.", 410, { code: "SESSION_EXPIRED" });
  if (state === "PAID") return bad("This ride has already been paid.", 409, { code: "ALREADY_PAID" });

  const { data: txs } = await admin.from("transactions").select("id, status").eq("ride_session_id", s.id);
  if ((txs ?? []).some((t) => PAID_STATES.includes(t.status as string))) {
    await admin.from("ride_sessions").update({ status: "PAID", paid_at: new Date().toISOString() }).eq("id", s.id).eq("status", "OPEN");
    return bad("This ride has already been paid.", 409, { code: "ALREADY_PAID" });
  }
  if (!s.opened_at) await admin.from("ride_sessions").update({ opened_at: new Date().toISOString() }).eq("id", s.id).is("opened_at", null);

  const r = await createPayNode(admin, s.partner.merchant_id, Number(s.amount), "RIDE", null, { rideSessionId: s.id, accounts: s.accounts as StoredAccount[] });
  if (!r.ok) return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json({ ...r.tx, ride: { partner: s.partner.name, expires_at: s.expires_at } }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
