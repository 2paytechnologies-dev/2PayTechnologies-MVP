import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { getAdapter } from "@/lib/rails";
import { recordWatchdogEvent } from "@/lib/watchdog";
import { BANKS, WALLETS } from "@/lib/constants";
import { sendReceiptSms } from "@/lib/receipts";

export const dynamic = "force-dynamic";

const MAX_BODY = 64 * 1024;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Exact aliases for the names providers use. Anything not listed keeps the institution the payer chose. */
const ALIASES: Record<string, string> = {
  telebirr: "Telebirr",
  telebirrussd: "Telebirr",
  mpesa: "M-Pesa",
  kacha: "Kacha",
  yaya: "YaYa Wallet",
  amole: "Amole",
  cbebirr: "CBE Birr",
  cbe: "Commercial Bank of Ethiopia (CBE)",
  awash: "Awash Bank",
  boa: "Bank of Abyssinia",
  zamzam: "ZamZam Bank",
  dashen: "Dashen Bank",
  wegagen: "Wegagen Bank",
  nib: "Nib International Bank",
  ahadu: "Ahadu Bank",
};

/** The institution the payer actually used, if the provider's name for it is recognised exactly. */
function institutionFor(providerMethod: string | undefined): string | undefined {
  if (!providerMethod) return undefined;
  const want = norm(providerMethod);
  return ALIASES[want] ?? [...WALLETS, ...BANKS].find((n) => norm(n) === want);
}

/**
 * Settlement receiver for ANY rail: /api/webhooks/arifpay, /api/webhooks/<next-provider>, ...
 * Order matters: store the raw event, authenticate it, then (and only then) change the sale.
 * Idempotent: a replayed callback for a settled sale is acknowledged and changes nothing.
 */
export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const adapter = getAdapter(provider);
  if (!adapter) return NextResponse.json({ error: "Unknown provider" }, { status: 404 });

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY) return NextResponse.json({ error: "Payload too large" }, { status: 413 });

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }

  const auth = adapter.verifyWebhook({ rawBody, headers: req.headers, url: new URL(req.url) });

  let body: unknown = {};
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    body = { _unparsed: rawBody.slice(0, 2000) };
  }
  const event = auth === "ok" ? adapter.parseWebhook(body) : null;

  // Keep every callback, authentic or not, so mappings can be fixed from real payloads and abuse can be seen.
  const { data: logged } = await admin
    .from("rail_events")
    .insert({ provider, nonce: event?.nonce ?? null, signature_ok: auth === "ok", event_status: event?.status ?? null, payload: body })
    .select("id")
    .single();
  const logId = logged?.id as string | undefined;
  const note = (applied: boolean, text: string, transactionId?: string) =>
    logId ? admin.from("rail_events").update({ applied, note: text, ...(transactionId ? { transaction_id: transactionId } : {}) }).eq("id", logId).then(() => {}, () => {}) : Promise.resolve();

  if (auth === "unconfigured") return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  if (auth === "bad") return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  if (!event) {
    await note(false, "payload had no recognisable payment status");
    return NextResponse.json({ acknowledged: true }); // authentic but not a payment outcome
  }
  if (!event.nonce) {
    await note(false, "no nonce in payload: cannot match a sale");
    return NextResponse.json({ error: "Cannot match this event to a sale" }, { status: 422 });
  }

  const { data: tx, error: findErr } = await admin
    .from("transactions")
    .select("id, merchant_id, status, amount, expected_amount, currency, rail")
    .eq("rail_nonce", event.nonce)
    .maybeSingle();
  if (findErr) {
    console.error("[webhook] lookup:", findErr.message);
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 }); // non-2xx so the provider retries
  }
  if (!tx) {
    await note(false, "no sale with this nonce");
    return NextResponse.json({ error: "Unknown nonce" }, { status: 404 });
  }

  if (event.status === "PENDING") {
    await note(false, "intermediate status; no change", tx.id);
    return NextResponse.json({ acknowledged: true });
  }

  if (event.status === "FAILED") {
    const { data: failed } = await admin.from("transactions").update({ status: "FAILED" }).eq("id", tx.id).in("status", ["PENDING", "PROCESSING"]).select("id");
    await note(!!failed?.length, failed?.length ? "marked FAILED" : `ignored: sale already ${tx.status}`, tx.id);
    return NextResponse.json({ acknowledged: true });
  }

  // ---- SETTLED ----
  const settledAmount = event.amount;
  const paidVia = institutionFor(event.paymentMethod);
  const { data: settled, error: updErr } = await admin
    .from("transactions")
    .update({
      status: "SETTLED",
      settled_at: new Date().toISOString(),
      ...(settledAmount != null ? { settled_amount: Math.round(settledAmount * 100) / 100 } : {}),
      ...(event.providerRef ? { arifpay_ref: event.providerRef } : {}),
      ...(paidVia ? { rail: paidVia } : {}),
    })
    .eq("id", tx.id)
    .in("status", ["PENDING", "PROCESSING", "SUCCESS"]) // single-shot even under concurrent retries
    .select("id, merchant_id, amount, expected_amount, currency")
    .maybeSingle();
  if (updErr) {
    console.error("[webhook] settle:", updErr.message);
    return NextResponse.json({ error: "Settlement update failed" }, { status: 500 });
  }
  if (!settled) {
    if (tx.status === "FAILED") {
      await recordWatchdogEvent(admin, {
        event_type: "SETTLEMENT_MISMATCH",
        severity: "HIGH",
        risk_score: 75,
        merchant_id: tx.merchant_id,
        transaction_id: tx.id,
        message: `${adapter.label} reported a successful payment for a sale already marked FAILED (ref ${event.providerRef ?? "n/a"}). Funds may have moved.`,
        details: { provider, provider_ref: event.providerRef ?? null, amount: settledAmount ?? null },
      });
    }
    await note(false, `ignored: sale already ${tx.status}`, tx.id);
    return NextResponse.json({ acknowledged: true });
  }

  // Watchdog: what the rail collected must equal what 2Pay quoted.
  const expected = Number(settled.expected_amount ?? settled.amount);
  let detail = "settled";
  if (settledAmount == null) {
    detail = "settled; provider sent no amount to check";
  } else if (Math.abs(settledAmount - expected) > 0.005) {
    detail = `settled with AMOUNT MISMATCH (expected ${expected}, got ${settledAmount})`;
    await recordWatchdogEvent(admin, {
      event_type: "SETTLEMENT_MISMATCH",
      severity: "CRITICAL",
      risk_score: 95,
      merchant_id: settled.merchant_id,
      transaction_id: settled.id,
      message: `Settled ${settledAmount} ${settled.currency} but expected ${expected} ${settled.currency} (${adapter.label} ref ${event.providerRef ?? "n/a"}).`,
      details: { provider, provider_ref: event.providerRef ?? null, expected_amount: expected, settled_amount: settledAmount, delta: Math.round((settledAmount - expected) * 100) / 100 },
    });
  }
  await note(true, detail, settled.id);
  await sendReceiptSms(admin, settled.id);
  return NextResponse.json({ acknowledged: true });
}
