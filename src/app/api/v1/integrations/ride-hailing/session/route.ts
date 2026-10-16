import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { audit } from "@/lib/audit";
import { maskAccount, type SavedAccount } from "@/lib/settlement";
import { sealAccounts, openAccounts, type StoredAccount } from "@/lib/fieldcrypt";
import { priceTransaction } from "@/lib/pricing/engine";
import { newSessionToken, parseRideIntent, sessionLinks } from "@/lib/ride";
import { PAID_STATES, authPartner, bad, baseUrlFor, driverStoredAccounts, viewSession } from "@/lib/ride-server";

export const dynamic = "force-dynamic";

/** How long the link given to the driver's phone stays usable. A ride's checkout can wait; each QR/tap node inside it lives 90 s. */
const TTL_MS = Math.max(5, Number(process.env.RIDE_SESSION_TTL_MINUTES) || 30) * 60_000;

const masked = (list: SavedAccount[]) => list.map((a) => ({ rail: a.institution, account_masked: maskAccount(a.account_number) }));

/**
 * A ride-hailing company starts a checkout for a finished trip. Authenticated with the company's API key:
 *   POST { partner_ride_id, driver_id, fare_amount, currency: "ETB" }
 * `driver_id` is the company's own id for the driver, who has registered with 2Pay and been LINKED to the company (see .../drivers).
 * The money goes to the accounts the DRIVER confirmed in their own 2Pay app; the company never sends or holds them. (A company an admin
 * has switched to "send accounts yourself" may still add `driver_wallet_accounts: [{ rail, account_number }]`; that is the older, unverified mode.)
 *
 * The driver's 2Pay app catches the ride at once (it is waiting for it) and opens the fare; the reply also carries the links
 * (`twopay://checkout?token=...`, an Android intent, the https terminal page) in case the company wants to launch the app itself.
 *
 * Safe to retry: the same partner_ride_id is the same ride. While unpaid it can be re-sent (the link is replaced, the fare updated);
 * once paid it is refused. A sale in progress is never changed under a payer.
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

  // Who is paid: the driver's own confirmed 2Pay accounts (normal), or accounts the company sent (only if an admin allowed it for this company).
  let driverMerchantId: string | null = null;
  let stored: StoredAccount[] | null = null;
  let shown: SavedAccount[];
  if (accounts) {
    if (!partner.allow_partner_accounts) return bad("This company's drivers are paid to their own 2Pay accounts. Link the driver, then send the ride without account details.", 400, { code: "PARTNER_ACCOUNTS_NOT_ALLOWED" });
    stored = sealAccounts(accounts);
    shown = accounts;
  } else {
    const { data: link } = await admin.from("ride_driver_links").select("status, merchant_id").eq("partner_id", partner.id).eq("driver_ref", driverId).maybeSingle();
    if (!link || link.status !== "ACTIVE" || !link.merchant_id) {
      return bad("This driver is not linked to 2Pay yet.", 409, { code: "DRIVER_NOT_LINKED", link_status: link?.status ?? "NONE" });
    }
    const got = await driverStoredAccounts(admin, link.merchant_id as string);
    if (!got.ok) return bad(got.error, 409, { code: got.code });
    driverMerchantId = link.merchant_id as string;
    shown = openAccounts(got.accounts);
  }

  const { token, hash } = newSessionToken();
  const expires_at = new Date(Date.now() + TTL_MS).toISOString();

  const { data: existing } = await admin.from("ride_sessions").select("id, driver_id, status, accounts").eq("partner_id", partner.id).eq("partner_ride_id", partnerRideId).maybeSingle();
  let id: string;
  let replaced = false;
  if (existing) {
    if (existing.status === "PAID") return bad("This ride has already been paid.", 409, { code: "ALREADY_PAID", session_id: existing.id });
    if (existing.driver_id !== driverId) return bad("This partner_ride_id was already used for a different driver.", 409, { code: "DRIVER_MISMATCH" });
    const { data: live } = await admin.from("transactions").select("id, status").eq("ride_session_id", existing.id);
    if ((live ?? []).some((t) => t.status === "PROCESSING" || PAID_STATES.includes(t.status as string))) return bad("A payment for this ride is already in progress.", 409, { code: "PAYMENT_IN_PROGRESS" });
    // A repeat of the same intent keeps the account ids the passenger may be looking at; a changed one replaces them.
    let keep = false;
    if (stored && existing.accounts) {
      const before = openAccounts(existing.accounts as StoredAccount[]);
      keep = before.length === shown.length && shown.every((a) => before.some((b) => b.institution === a.institution && b.account_number === a.account_number));
    }
    const { error } = await admin
      .from("ride_sessions")
      .update({ accounts: keep ? existing.accounts : stored, driver_merchant_id: driverMerchantId, amount: fare, token_hash: hash, status: "OPEN", expires_at, opened_at: null })
      .eq("id", existing.id);
    if (error) return bad("Could not update the ride", 500);
    id = existing.id;
    replaced = true;
  } else {
    const { data, error } = await admin
      .from("ride_sessions")
      .insert({ partner_id: partner.id, partner_ride_id: partnerRideId, driver_id: driverId, driver_merchant_id: driverMerchantId, accounts: stored, amount: fare, currency: "ETB", token_hash: hash, expires_at })
      .select("id")
      .single();
    if (error || !data) {
      console.error("[ride session]", error?.message);
      return bad("Could not create the ride. Has the latest SQL in supabase/ (v2_7.sql) been run?", 500);
    }
    id = data.id;
  }

  await audit(admin, null, req, {
    action: replaced ? "ride.session.update" : "ride.session.create",
    targetType: "ride_session",
    targetId: id,
    merchantId: driverMerchantId ?? partner.merchant_id,
    details: { partner: partner.name, ride: partnerRideId, driver: driverId, amount: fare, accounts: masked(shown), linked: !!driverMerchantId },
  });

  return NextResponse.json(
    {
      session_id: id,
      session_token: token,
      expires_at,
      ...sessionLinks(baseUrlFor(req), token),
      fare: { amount: fare, currency: "ETB" },
      pricing: { base_fee: price.base_fee, vat_fee: price.vat_fee, total_fee: price.total_fee, net_driver_settlement: price.net_merchant_settlement },
      payout_accounts: masked(shown),
      driver_app: driverMerchantId ? "the driver's 2Pay app opens this ride by itself while it is open" : null,
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
