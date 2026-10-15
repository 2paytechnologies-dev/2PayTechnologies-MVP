import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { authorizeSimulated } from "@/lib/payments";
import { getAdapter, publicBaseUrl, railMode, RailError, registeredIds } from "@/lib/rails";
import { candidatesFor, loadHealth, parseRouting, rankProviders, recordAttempt } from "@/lib/rails/router";
import { normalizePhone } from "@/lib/auth";
import { clientIp } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";
import { saveReceiptContact } from "@/lib/receipts";
import { cleanTip } from "@/lib/team";
import { chooseRoute, findPayerApp, transferFor } from "@/lib/routing-hub";
import { bankCodeFor, hasLinks, needsPayload, platformOf, resolveAppLink } from "@/lib/applinks";
import { buildEthQr } from "@/lib/ethqr";
import { referenceFor } from "@/lib/format";
import { openAccounts, type StoredAccount } from "@/lib/fieldcrypt";
import { maskAccount, type SavedAccount } from "@/lib/settlement";
import { chooseDriverAccount, kindOfInstitution } from "@/lib/ride";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A started provider session is reused for this long, so a payer who comes back never creates a second charge. */
const SESSION_REUSE_MS = 25 * 60_000;
/** Provider-side session lifetime. Callbacks may arrive after our own 90s pay-node TTL. */
const SESSION_TTL_MS = 30 * 60_000;

interface Tx {
  id: string;
  token: string;
  amount: number;
  currency: string;
  status: string;
  expires_at: string;
  merchant_id: string;
  /** Ride-hailing sales only: the driver's own (encrypted) accounts. They replace the merchant's saved accounts as the payee. */
  payee_accounts: StoredAccount[] | null;
  routed_bank: { id: string; institution: string } | null;
  routed_wallet: { id: string; institution: string } | null;
  rail_checkout_url: string | null;
  processing_at: string | null;
  merchants: MerchantInfo | MerchantInfo[] | null;
}

interface MerchantInfo {
  business_name: string;
  category: string;
  location: string | null;
  saved_banks: StoredAccount[] | null;
  saved_wallets: StoredAccount[] | null;
}

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

/**
 * A ride-hailing sale pays the DRIVER, who may have several accounts (for example Telebirr and CBE Birr). The passenger either taps
 * their own app (the best matching driver account is chosen) or one of the driver's accounts directly (`account_id`). The choice
 * is written onto the sale, so everything after this (the simulated authorization, the provider session, the app link) pays it.
 * Returns null for an ordinary sale, `{ error }` for a bad choice, else the chosen account's kind.
 */
async function applyPayeeChoice(admin: ReturnType<typeof getAdminClient>, token: string, app: ReturnType<typeof findPayerApp>, accountId: unknown): Promise<null | { error: string } | { method: "bank" | "wallet" }> {
  const { data } = await admin.from("transactions").select("payee_accounts, status").eq("token", token).maybeSingle();
  if (!data?.payee_accounts) return null;
  if (data.status !== "PENDING") return null; // a payer coming back to a started payment keeps the account already chosen
  const pool = openAccounts(data.payee_accounts as StoredAccount[]);
  if (typeof accountId === "string" && !pool.some((a) => a.id === accountId)) return { error: "That account is not one of the driver's accounts" };
  const picked = chooseDriverAccount(app, pool, typeof accountId === "string" ? accountId : null);
  if (!picked) return { error: "The driver has no payment account" };
  const method = kindOfInstitution(picked.institution);
  const masked = { id: picked.id, institution: picked.institution, account_masked: maskAccount(picked.account_number) };
  await admin.from("transactions").update({ routed_bank: method === "bank" ? masked : null, routed_wallet: method === "wallet" ? masked : null }).eq("token", token).eq("status", "PENDING");
  return { method };
}

/**
 * The payer tapped their own bank or wallet app on the grid (`payer_app`), or one of the merchant's two methods (`method`).
 * With `payer_app`, the server picks which of the merchant's active accounts receives the payment (see routing-hub.ts).
 *  simulated mode: authorize at once (no money moves).
 *  live mode:      start a payment with the best available rail and return where to send the payer. The sale is marked
 *                  paid only by the rail's verified callback, never by this request.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!UUID.test(token)) return fail("Malformed token", 400);
  const body = await req.json().catch(() => ({}));
  let method = body?.method === "bank" || body?.method === "wallet" ? (body.method as "bank" | "wallet") : null;
  // The customer's own app, picked from the grid. Only a known national bank or wallet is accepted ("other" = not listed).
  const payerApp = findPayerApp(body?.payer_app);
  if (body?.payer_app !== undefined && body.payer_app !== "other" && !payerApp) return fail("Unknown bank or wallet app", 400);
  const accountId = body?.account_id;
  if (!method && !payerApp && accountId === undefined) return fail("method must be 'bank' or 'wallet', or choose your app", 400);
  const lang = body?.lang === "am" ? "am" : "en";

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    if (e instanceof AdminConfigError) return fail("Server misconfigured", 500);
    throw e;
  }

  // Abuse guard: each call can create a provider session, so limit per payer and per sale.
  if (!(await rateLimit(admin, `initiate:ip:${clientIp(req)}`, 30, 60)) || !(await rateLimit(admin, `initiate:tx:${token}`, 12, 60))) {
    return fail("Too many attempts. Please wait a moment and try again.", 429);
  }

  const choice = await applyPayeeChoice(admin, token, payerApp, accountId);
  if (choice && "error" in choice) return fail(choice.error, 400);
  if (choice) method = choice.method;

  const mode = railMode();
  const rawPhone = typeof body?.phone === "string" ? body.phone.trim() : "";
  const payerPhone = rawPhone ? normalizePhone(rawPhone) : null;
  if (rawPhone && !payerPhone) return fail("That mobile number doesn't look right. Use the format 0911223344.", 400);
  if (mode === "live" && !payerPhone) return fail("Enter the mobile number of the account you are paying from, e.g. 0911223344", 400);

  const receiptUrl = `/pay/${token}/receipt`;

  // An optional tip: the customer chose to pay more than the receipt. The bill stays the revenue; the extra is the tip.
  const tipRequested = body?.tip;

  if (mode === "simulated") {
    let simTip = 0;
    if (tipRequested !== undefined && Number(tipRequested) !== 0) {
      const { data: bill } = await admin.from("transactions").select("amount").eq("token", token).maybeSingle();
      const t = bill ? cleanTip(tipRequested, Number(bill.amount)) : null;
      if (t === null) return fail("That tip amount is not valid.", 400);
      simTip = t;
    }
    if (!method || payerApp) {
      // Pick the merchant's receiving account for this customer's app, and remember the customer's choice.
      const { data: routes } = await admin.from("transactions").select("routed_bank, routed_wallet").eq("token", token).maybeSingle();
      const pick = chooseRoute(payerApp, { bank: routes?.routed_bank?.institution ?? null, wallet: routes?.routed_wallet?.institution ?? null });
      if (!pick) return fail("The merchant does not accept payments yet", 400);
      if (!method) method = pick.method;
      if (payerApp) await admin.from("transactions").update({ payer_app: payerApp.name }).eq("token", token).eq("status", "PENDING");
    }
    const r = await authorizeSimulated(admin, token, method, payerPhone ? { phone: payerPhone, lang } : undefined, simTip);
    return r.ok ? NextResponse.json({ mode: "simulated", next: receiptUrl, latency_ms: r.tx.latency_ms, rail: r.tx.rail }) : fail(r.error, r.status);
  }

  // ---- live ----
  const { data, error } = await admin
    .from("transactions")
    .select(
      "id, token, amount, currency, status, expires_at, merchant_id, payee_accounts, routed_bank, routed_wallet, rail_checkout_url, processing_at, merchants(business_name, category, location, saved_banks, saved_wallets)",
    )
    .eq("token", token)
    .maybeSingle();
  if (error) {
    console.error("[initiate] lookup:", error.message);
    return fail("Could not load the payment", 500);
  }
  const tx = data as unknown as Tx | null;
  if (!tx) return fail("This pay node does not exist", 404);

  if (tx.status === "SUCCESS" || tx.status === "SETTLED") return NextResponse.json({ mode: "done", next: receiptUrl });
  if (tx.status === "FAILED") return fail("This payment failed. Ask the cashier for a new code.", 410);
  if (tx.status === "PENDING" && new Date(tx.expires_at).getTime() <= Date.now()) return fail("This pay node has expired. Ask the cashier for a new code.", 410);

  // A payer who comes back (cancelled, closed the tab) gets the same provider session, not a second charge.
  if (tx.status === "PROCESSING" && tx.rail_checkout_url && tx.processing_at && Date.now() - new Date(tx.processing_at).getTime() < SESSION_REUSE_MS) {
    return NextResponse.json({ mode: "redirect", url: tx.rail_checkout_url });
  }

  const bill = Number(tx.amount);
  const tip = cleanTip(tipRequested, bill);
  if (tip === null) return fail("That tip amount is not valid.", 400);
  const charge = Math.round((bill + tip) * 100) / 100; // what the provider collects: the receipt plus the tip

  if (!method) {
    const pick = chooseRoute(payerApp, { bank: tx.routed_bank?.institution ?? null, wallet: tx.routed_wallet?.institution ?? null });
    if (!pick) return fail("The merchant does not accept payments yet", 400);
    method = pick.method;
  }
  const routed = method === "bank" ? tx.routed_bank : tx.routed_wallet;
  if (!routed) return fail("The merchant does not accept that payment method", 400);

  const merchant = Array.isArray(tx.merchants) ? tx.merchants[0] : tx.merchants;
  // The payee's accounts of one kind: the driver's for a ride, otherwise the merchant's own.
  const payeeAccounts = (kind: "bank" | "wallet") => (tx.payee_accounts ? openAccounts(tx.payee_accounts).filter((a) => kindOfInstitution(a.institution) === kind) : openAccounts(kind === "bank" ? merchant?.saved_banks : merchant?.saved_wallets));
  const beneficiary =
    method === "bank"
      ? (() => {
          const acct = payeeAccounts("bank").find((a) => a.id === routed.id);
          return acct ? { institution: acct.institution, accountNumber: acct.account_number } : null;
        })()
      : undefined;
  if (method === "bank" && !beneficiary) return fail("The merchant changed their account. Ask the cashier for a new code.", 409);

  let baseUrl: string;
  try {
    baseUrl = publicBaseUrl();
  } catch (e) {
    console.error("[initiate] configuration:", (e as Error).message);
    return fail("Payments are not configured yet", 503);
  }

  // Smart routing: the operator's preferred providers for this institution, healthy ones first.
  const registered = registeredIds();
  const candidates = candidatesFor(routed.institution, parseRouting(process.env.RAIL_ROUTING), registered, process.env.RAIL_PROVIDER ?? "arifpay");
  if (!candidates.length) {
    console.error("[initiate] no registered provider for", routed.institution);
    return fail("Payments are not configured yet", 503);
  }
  const ranked = rankProviders(candidates, await loadHealth(admin, candidates));

  const nonce = randomUUID().replace(/-/g, "");
  let session: { sessionId: string; checkoutUrl: string } | null = null;
  let providerId = "";
  let lastError: RailError | Error | null = null;
  for (const id of ranked) {
    const adapter = getAdapter(id)!;
    try {
      session = await adapter.createPayment({
        token,
        transactionId: tx.id,
        amount: charge,
        currency: tx.currency,
        method,
        institution: routed.institution,
        merchantName: merchant?.business_name ?? "2Pay merchant",
        beneficiary: beneficiary ?? undefined,
        nonce,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        payerPhone: payerPhone!,
        urls: {
          success: `${baseUrl}${receiptUrl}`,
          cancel: `${baseUrl}/pay/${token}?cancelled=1`,
          error: `${baseUrl}/pay/${token}?error=1`,
          notify: adapter.notifyUrl(baseUrl),
        },
      });
      providerId = id;
      await recordAttempt(admin, id, routed.institution, true);
      break;
    } catch (e) {
      lastError = e as Error;
      console.error(`[initiate] ${id} failed:`, (e as Error).message);
      await recordAttempt(admin, id, routed.institution, false, (e as Error).message);
      // try the next provider in line
    }
  }
  if (!session) {
    const retryable = lastError instanceof RailError && lastError.retryable;
    return fail(retryable ? "The payment provider is unreachable right now. Please try again in a moment." : "The payment provider could not start this payment.", 502);
  }

  // First writer wins: only a still-PENDING sale can be claimed, so two quick taps never leave an orphaned session.
  const { data: claimed, error: updErr } = await admin
    .from("transactions")
    .update({
      status: "PROCESSING",
      rail: routed.institution,
      settlement_method: method.toUpperCase(),
      rail_provider: providerId,
      rail_session_id: session.sessionId,
      rail_nonce: nonce,
      rail_checkout_url: session.checkoutUrl,
      processing_at: new Date().toISOString(),
      // The provider was asked for the receipt plus the tip, so that is what the watchdog expects back.
      ...(tip > 0 ? { tip_amount: tip, expected_amount: charge } : {}),
      ...(payerApp ? { payer_app: payerApp.name } : {}),
    })
    .eq("id", tx.id)
    .eq("status", "PENDING")
    .select("id");
  if (updErr) {
    console.error("[initiate] claim:", updErr.message);
    return fail("Could not start the payment", 500);
  }
  if (!claimed?.length) {
    const { data: again } = await admin.from("transactions").select("status, rail_checkout_url").eq("id", tx.id).maybeSingle();
    if (again?.status === "PROCESSING" && again.rail_checkout_url) return NextResponse.json({ mode: "redirect", url: again.rail_checkout_url });
    if (again?.status === "SUCCESS" || again?.status === "SETTLED") return NextResponse.json({ mode: "done", next: receiptUrl });
    return fail("This payment can no longer be started", 409);
  }

  if (payerPhone) await saveReceiptContact(admin, tx.id, payerPhone, lang);
  // Open the CUSTOMER's own app on the right screen, pre-filled, if the operator configured a link for it (RAIL_APP_LINKS).
  // Same bank: its "transfer within the bank". A different bank: its "transfer to other banks" (EthSwitch) screen with the
  // merchant's bank selected and the account number and amount filled in. Never required: without a link, or if the app does
  // not open, the web checkout carries on.
  const appName = payerApp?.name ?? routed.institution;
  const rawLinks = process.env.RAIL_APP_LINKS;
  let appLink: string | undefined;
  if (hasLinks(rawLinks, appName)) {
    const acct = payeeAccounts(method).find((a) => a.id === routed.id);
    const ref = referenceFor(tx.id);
    const transfer = transferFor(payerApp, routed.institution, method);
    const payload =
      acct && needsPayload(rawLinks, appName)
        ? buildEthQr({ merchantName: merchant?.business_name ?? "2Pay merchant", category: merchant?.category ?? "Retail", city: merchant?.location, account: { institution: acct.institution, account_number: acct.account_number }, amount: charge, reference: ref })
        : null;
    appLink = resolveAppLink(
      rawLinks,
      appName,
      platformOf(req.headers.get("user-agent")),
      { url: session.checkoutUrl, payload, amount: charge.toFixed(2), ref, account: acct?.account_number ?? null, bank: routed.institution, bank_code: bankCodeFor(routed.institution), name: merchant?.business_name ?? null },
      transfer,
    );
  }
  // `transfer` tells the pay page which screen it is opening, so it can say so ("Opening Awash Bank: transfer to other banks").
  const transferKind = transferFor(payerApp, routed.institution, method);  return NextResponse.json({ mode: "redirect", url: session.checkoutUrl, appLink, transfer: transferKind, to: routed.institution });
}
