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
import type { SavedAccount } from "@/lib/settlement";

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
  routed_bank: { id: string; institution: string } | null;
  routed_wallet: { id: string; institution: string } | null;
  rail_checkout_url: string | null;
  processing_at: string | null;
  merchants: { business_name: string; saved_banks: SavedAccount[] | null } | { business_name: string; saved_banks: SavedAccount[] | null }[] | null;
}

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

/**
 * Optional per-institution deep link into the bank or wallet app, from RAIL_APP_LINKS:
 *   {"Telebirr":"<provider-documented link>?pay={url}"}   ({url} is replaced by the encoded checkout URL)
 * No values are built in: each app's real link format must come from that provider. The pay page tries the app link and
 * falls back to the web checkout if the app did not open.
 */
function appLinkFor(institution: string, checkoutUrl: string): string | undefined {
  try {
    const template = (JSON.parse(process.env.RAIL_APP_LINKS ?? "{}") as Record<string, unknown>)[institution];
    return typeof template === "string" && /^[a-z][a-z0-9+.-]*:/i.test(template) && !/^javascript:/i.test(template)
      ? template.replace("{url}", encodeURIComponent(checkoutUrl))
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The payer tapped "Pay via <bank or wallet>".
 *  simulated mode: authorize at once (no money moves).
 *  live mode:      start a payment with the best available rail and return where to send the payer. The sale is marked
 *                  paid only by the rail's verified callback, never by this request.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!UUID.test(token)) return fail("Malformed token", 400);
  const body = await req.json().catch(() => ({}));
  const method = body?.method === "bank" || body?.method === "wallet" ? (body.method as "bank" | "wallet") : null;
  if (!method) return fail("method must be 'bank' or 'wallet'", 400);
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
    const r = await authorizeSimulated(admin, token, method, payerPhone ? { phone: payerPhone, lang } : undefined, simTip);
    return r.ok ? NextResponse.json({ mode: "simulated", next: receiptUrl, latency_ms: r.tx.latency_ms, rail: r.tx.rail }) : fail(r.error, r.status);
  }

  // ---- live ----
  const { data, error } = await admin
    .from("transactions")
    .select(
      "id, token, amount, currency, status, expires_at, merchant_id, routed_bank, routed_wallet, rail_checkout_url, processing_at, merchants(business_name, saved_banks)",
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

  const routed = method === "bank" ? tx.routed_bank : tx.routed_wallet;
  if (!routed) return fail("The merchant does not accept that payment method", 400);

  const merchant = Array.isArray(tx.merchants) ? tx.merchants[0] : tx.merchants;
  const beneficiary =
    method === "bank"
      ? (() => {
          const acct = (merchant?.saved_banks ?? []).find((a) => a.id === routed.id);
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
  return NextResponse.json({ mode: "redirect", url: session.checkoutUrl, appLink: appLinkFor(routed.institution, session.checkoutUrl) });
}
