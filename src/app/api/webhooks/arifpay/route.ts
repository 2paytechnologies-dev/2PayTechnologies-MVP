import { NextResponse } from "next/server";
import { createHmac } from "node:crypto";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { recordWatchdogEvent, safeEqual } from "@/lib/watchdog";
import { RAILS, type Rail } from "@/lib/types";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OK_STATUSES = new Set(["SUCCESS", "SETTLED"]);
const FAIL_STATUSES = new Set(["FAILED", "CANCELLED", "CANCELED", "EXPIRED", "REJECTED"]);

/**
 * Authenticity check. ASSUMPTION: Arifpay (or the gateway in front of it) signs the raw body with
 * HMAC-SHA256 using ARIFPAY_WEBHOOK_SECRET and sends the hex digest in `x-arifpay-signature`.
 * Confirm the real header/scheme against Arifpay's merchant docs and adjust here.
 * In production the endpoint fails closed when the secret is not configured.
 */
function verifySignature(raw: string, header: string | null): "ok" | "bad" | "unconfigured" {
  const secret = process.env.ARIFPAY_WEBHOOK_SECRET;
  if (!secret) return process.env.NODE_ENV === "production" ? "unconfigured" : "ok";
  if (!header) return "bad";
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  return safeEqual(expected, header.trim().toLowerCase()) ? "ok" : "bad";
}

/** Asynchronous settlement receiver. Idempotent: replays of a settled transaction are acknowledged and ignored. */
export async function POST(req: Request) {
  const raw = await req.text();

  const sig = verifySignature(raw, req.headers.get("x-arifpay-signature"));
  if (sig === "unconfigured") return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  if (sig === "bad") return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const token = typeof body.transaction_token === "string" ? body.transaction_token : "";
  const arifpayRef = typeof body.arifpay_ref === "string" ? body.arifpay_ref.slice(0, 120) : "";
  const status = typeof body.status === "string" ? body.status.trim().toUpperCase() : "";
  const settledAmount = Number(body.settled_amount);
  const railRaw = typeof body.rail === "string" ? body.rail.trim().toLowerCase() : "";
  const rail: Rail | undefined = RAILS.find((r) => r.toLowerCase() === railRaw);

  if (!UUID.test(token) || !arifpayRef || !status) {
    return NextResponse.json({ error: "transaction_token, arifpay_ref and status are required" }, { status: 400 });
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }

  // ---- Failure notifications: close out a transaction that never completed.
  if (FAIL_STATUSES.has(status)) {
    await admin.from("transactions").update({ status: "FAILED", arifpay_ref: arifpayRef }).eq("token", token).eq("status", "PENDING");
    return NextResponse.json({ acknowledged: true });
  }
  if (!OK_STATUSES.has(status)) {
    return NextResponse.json({ error: `Unsupported status "${status}"` }, { status: 400 });
  }
  if (!Number.isFinite(settledAmount) || settledAmount < 0) {
    return NextResponse.json({ error: "settled_amount must be a non-negative number" }, { status: 400 });
  }

  // ---- Settle atomically. The status guard makes this single-shot even under concurrent retries.
  const { data: settled, error } = await admin
    .from("transactions")
    .update({
      status: "SETTLED",
      settled_at: new Date().toISOString(),
      settled_amount: Math.round(settledAmount * 100) / 100,
      arifpay_ref: arifpayRef,
      ...(rail ? { rail } : {}),
    })
    .eq("token", token)
    .in("status", ["PENDING", "SUCCESS"])
    .select("id, merchant_id, amount, expected_amount, currency")
    .maybeSingle();

  if (error) {
    console.error("[arifpay-webhook] update failed:", error.message);
    return NextResponse.json({ error: "Settlement update failed" }, { status: 500 }); // non-2xx => Arifpay retries
  }

  if (!settled) {
    const { data: existing } = await admin.from("transactions").select("id, status, merchant_id").eq("token", token).maybeSingle();
    if (!existing) return NextResponse.json({ error: "Unknown transaction_token" }, { status: 404 });
    if (existing.status === "FAILED") {
      await recordWatchdogEvent(admin, {
        event_type: "SETTLEMENT_MISMATCH",
        severity: "HIGH",
        risk_score: 70,
        merchant_id: existing.merchant_id,
        transaction_id: existing.id,
        message: `Arifpay reported ${status} for a transaction already marked FAILED (ref ${arifpayRef}).`,
        details: { arifpay_ref: arifpayRef, settled_amount: settledAmount, local_status: "FAILED" },
      });
    }
    return NextResponse.json({ acknowledged: true }); // already settled: idempotent replay
  }

  // ---- Watchdog: settled amount must equal what 2Pay quoted.
  const expected = Number(settled.expected_amount ?? settled.amount);
  if (Math.abs(settledAmount - expected) > 0.005) {
    await recordWatchdogEvent(admin, {
      event_type: "SETTLEMENT_MISMATCH",
      severity: "CRITICAL",
      risk_score: 95,
      merchant_id: settled.merchant_id,
      transaction_id: settled.id,
      message: `Settled ${settledAmount} ${settled.currency} but expected ${expected} ${settled.currency} (ref ${arifpayRef}).`,
      details: { arifpay_ref: arifpayRef, expected_amount: expected, settled_amount: settledAmount, delta: Math.round((settledAmount - expected) * 100) / 100 },
    });
  }

  return NextResponse.json({ acknowledged: true });
}
