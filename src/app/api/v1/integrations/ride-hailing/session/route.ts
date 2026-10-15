import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { audit } from "@/lib/audit";
import { maskAccount, type SavedAccount } from "@/lib/settlement";
import { sealAccounts, openAccounts, type StoredAccount } from "@/lib/fieldcrypt";
import { priceTransaction } from "@/lib/pricing/engine";
import { newSessionToken, parseRideIntent, sessionLinks } from "@/lib/ride";
import { PAID_STATES, authPartner, bad, baseUrlFor, viewSession } from "@/lib/ride-server";

export const dynamic = "force-dynamic";

/** How long the link given to the driver's phone stays usable. A ride's checkout can wait; each QR/tap node inside it lives 90 s. */
const TTL_MS = Math.max(5, Number(process.env.RIDE_SESSION_TTL_MINUTES) || 30) * 60_000;

const masked = (list: SavedAccount[]) => list.map((a) => ({ rail: a.institution, account_masked: maskAccount(a.account_number) }));

/**
 * A ride-hailing partner starts a checkout for a finished trip. Authenticated with the partner's API key:
 *   POST { partner_ride_id, driver_id, driver_wallet_accounts: [{ rail, account_number }], fare_amount, currency: "ETB" }
 * The reply carries the link that opens 2Pay on the driver's phone with the fare already filled in (`twopay://checkout?token=...`,
 * an Android intent, and the https terminal page). The driver then holds the phone to the passenger's: the passenger sees the
 * driver's payout accounts and pays from their own app.
 *
 * Safe to retry: the same partner_ride_id is the same ride. While it is unpaid it can be re-sent (the link is replaced, the fare
 * or accounts updated); once paid it is refused. A sale in progress is never changed under a payer.
 */
export async function POST(req: Request) {
  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
  const auth = await authPartner(admin, req);
  if (!auth.ok) return auth.res;
  const { partner } = auth;

  const parsed = parseRideIntent(await req.json().catch(() => null));
  if (!parsed.ok) return bad(parsed.error, 400, { code: "INVALID_REQUEST" });
  const { partnerRideId, driverId, accounts, fare } = parsed.value;
  const price = priceTransaction(fare);
  if (price.net_merchant_settlement <= 0) return bad("That fare is too small to process.", 400, { code: "AMOUNT_TOO_SMALL" });

  const { token, hash } = newSessionToken();
  const expires_at = new Date(Date.now() + TTL_MS).toISOString();
  const stored = sealAccounts(accounts);

  const { data: existing } = await admin.from("ride_sessions").select("id, driver_id, status, accounts").eq("partner_id", partner.id).eq("partner_ride_id", partnerRideId).maybeSingle();
  let id: string;
  let replaced = false;
  if (existing) {
    if (existing.status === "PAID") return bad("This ride has already been paid.", 409, { code: "ALREADY_PAID", session_id: existing.id });
    if (existing.driver_id !== driverId) return bad("This partner_ride_id was already used for a different driver.", 409, { code: "DRIVER_MISMATCH" });
    const { data: live } = await admin.from("transactions").select("id, status").eq("ride_session_id", existing.id);
    if ((live ?? []).some((t) => t.status === "PROCESSING" || PAID_STATES.includes(t.status as string))) return bad("A payment for this ride is already in progress.", 409, { code: "PAYMENT_IN_PROGRESS" });
    // A repeat of the same intent keeps the account ids the passenger may be looking at; a changed one replaces them.
    const before = openAccounts(existing.accounts as StoredAccount[]);
    const same = before.length === accounts.length && accounts.every((a) => before.some((b) => b.institution === a.institution && b.account_number === a.account_number));
    const { error } = await admin
      .from("ride_sessions")
      .update({ accounts: same ? existing.accounts : stored, amount: fare, token_hash: hash, status: "OPEN", expires_at, opened_at: null })
      .eq("id", existing.id);
    if (error) return bad("Could not update the ride", 500);
    id = existing.id;
    replaced = true;
  } else {
    const { data, error } = await admin
      .from("ride_sessions")
      .insert({ partner_id: partner.id, partner_ride_id: partnerRideId, driver_id: driverId, accounts: stored, amount: fare, currency: "ETB", token_hash: hash, expires_at })
      .select("id")
      .single();
    if (error || !data) {
      console.error("[ride session]", error?.message);
      return bad("Could not create the ride. Has the latest SQL in supabase/ (v2_5.sql) been run?", 500);
    }
    id = data.id;
  }

  await audit(admin, null, req, {
    action: replaced ? "ride.session.update" : "ride.session.create",
    targetType: "ride_session",
    targetId: id,
    merchantId: partner.merchant_id,
    details: { partner: partner.name, ride: partnerRideId, driver: driverId, amount: fare, accounts: masked(accounts) },
  });

  return NextResponse.json(
    {
      session_id: id,
      session_token: token,
      expires_at,
      ...sessionLinks(baseUrlFor(req), token),
      fare: { amount: fare, currency: "ETB" },
      pricing: { base_fee: price.base_fee, vat_fee: price.vat_fee, total_fee: price.total_fee, net_driver_settlement: price.net_merchant_settlement },
      payout_accounts: masked(accounts),
    },
    { status: replaced ? 200 : 201, headers: { "Cache-Control": "no-store" } },
  );
}

/** Find a ride by the partner's own id: GET ?partner_ride_id=... (the same answer as GET session/{id}): its status and, once paid, the fee breakdown. */
export async function GET(req: Request) {
  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
  const auth = await authPartner(admin, req);
  if (!auth.ok) return auth.res;
  const rideId = new URL(req.url).searchParams.get("partner_ride_id") ?? "";
  if (!rideId) return bad("partner_ride_id is required");
  const { data } = await admin.from("ride_sessions").select("id").eq("partner_id", auth.partner.id).eq("partner_ride_id", rideId).maybeSingle();
  if (!data) return bad("No such ride", 404);
  return NextResponse.json(await viewSession(admin, data.id), { headers: { "Cache-Control": "no-store" } });
}
