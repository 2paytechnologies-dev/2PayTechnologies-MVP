import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { clientIp } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";
import { createPayNode } from "@/lib/pay-nodes";
import { isUuid } from "@/lib/settlement";
import { sha256, SESSION_TOKEN_RE } from "@/lib/ride";
import { PAID_STATES, bad, driverStoredAccounts, linkIsActive, sessionByToken, sessionForDriver, statusOf } from "@/lib/ride-server";
import { requireDriver } from "@/lib/driver-server";
import type { StoredAccount } from "@/lib/fieldcrypt";

export const dynamic = "force-dynamic";

/**
 * The driver's phone asks for the pay node to broadcast, in one of two ways:
 *   { session_token }  the checkout LINK a company handed over (the link is the credential), or
 *   { ride_id }        the driver is signed in to 2Pay and their app caught the ride by itself (the sign-in is the credential).
 * The fare and the payee come from the ride, never from the phone. For a linked driver the payee is the driver's own 2Pay accounts as they
 * are right now, and the sale is recorded in the driver's own ledger. Each call mints a fresh single-use node (/pay/{token}, 90 seconds) for the
 * tap and the QR; the phone asks again shortly before one expires.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const byRide = typeof body?.ride_id === "string";
  const token = body?.session_token;
  if (byRide ? !isUuid(body.ride_id) : typeof token !== "string" || !SESSION_TOKEN_RE.test(token)) return bad("This checkout link is not valid.", 400, { code: "SESSION_INVALID" });

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }

  let s;
  if (byRide) {
    const who = await requireDriver();
    if (!who.ok) return who.res;
    if (!(await rateLimit(admin, `ride:mint:m:${who.merchantId}`, 60, 60, { failClosed: true }))) return bad("Too many attempts. Please wait a moment.", 429);
    s = await sessionForDriver(admin, body.ride_id, who.merchantId);
  } else {
    if (!(await rateLimit(admin, `ride:mint:ip:${clientIp(req)}`, 60, 60, { failClosed: true })) || !(await rateLimit(admin, `ride:mint:${sha256(token).slice(0, 16)}`, 40, 60, { failClosed: true }))) {
      return bad("Too many attempts. Please wait a moment.", 429);
    }
    s = await sessionByToken(admin, token);
  }
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

  // Who is paid, and whose ledger the sale goes in.
  let ledger = s.partner.merchant_id;
  let payee = s.accounts as StoredAccount[] | null;
  if (s.driver_merchant_id) {
    if (!(await linkIsActive(admin, s.partner_id, s.driver_id, s.driver_merchant_id))) return bad("This driver is no longer linked to the company.", 409, { code: "DRIVER_NOT_LINKED" });
    const got = await driverStoredAccounts(admin, s.driver_merchant_id);
    if (!got.ok) return bad(got.error, 409, { code: got.code });
    ledger = s.driver_merchant_id;
    payee = got.accounts;
  }
  if (!payee?.length) return bad("This ride has no account to be paid into.", 409, { code: "NO_PAYEE" });

  const r = await createPayNode(admin, ledger, Number(s.amount), "RIDE", null, { rideSessionId: s.id, accounts: payee });
  if (!r.ok) return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json({ ...r.tx, ride: { partner: s.partner.name, expires_at: s.expires_at } }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
