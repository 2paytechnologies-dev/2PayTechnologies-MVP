import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The AI intelligence layer runs IN PARALLEL to every transaction, outside the country, and must never slow a payment, lose an event or
 * learn who anyone is. So:
 *
 *   1. The sale writes a small event (created, started, settled, failed) to an OUTBOX table in the same in-country database. Writing it
 *      is one quick insert, done after the response has gone, so the payment never waits for the AI layer.
 *   2. A dispatcher sends the outbox to the AI layer's address, SIGNED, in batches, and retries with growing waits until delivered.
 *   3. The event is PSEUDONYMISED before it is even written: tokens in place of the merchant and the sale (keyed hashes only 2Pay can
 *      make), the amount as a band, times and channel. Never an account number, a phone, a name or a pay link. A level of "full" also
 *      sends the exact amount, only if the lawyers say so.
 *   4. Scores come back through a signed callback (/api/ai/score) and are stored beside the sale.
 *
 * It is OFF unless AI_EVENT_LEVEL is "features" or "full" AND the sink address and secrets are set. Sending data abroad, even derived and
 * pseudonymised, needs a legal ruling first (Google Cloud has no Ethiopian region): see docs/DATA_RESIDENCY_AND_AI.md.
 */
export type AiStage = "CREATED" | "STARTED" | "SETTLED" | "FAILED";
export type AiLevel = "off" | "features" | "full";

type Env = Record<string, string | undefined>;

export function aiLevel(env: Env = process.env): AiLevel {
  const l = (env.AI_EVENT_LEVEL ?? "off").toLowerCase();
  return l === "features" || l === "full" ? l : "off";
}

/** Enabled only when the level, the sink and both secrets are all present: half a setup sends nothing. */
export function aiEnabled(env: Env = process.env): boolean {
  return aiLevel(env) !== "off" && !!env.AI_EVENT_SINK_URL && (env.AI_EVENT_SECRET ?? "").length >= 16 && (env.AI_PSEUDONYM_KEY ?? "").length >= 16;
}

export interface AiTxInput {
  id: string;
  merchant_id: string;
  amount: number | string;
  source?: string | null;
  rail?: string | null;
  rail_provider?: string | null;
  payer_app?: string | null;
  settlement_method?: string | null;
  tip_amount?: number | string | null;
  latency_ms?: number | null;
  fee_ft?: number | string | null;
  ride_session_id?: string | null;
}

export interface AiEvent {
  v: 1;
  event_id: string;
  stage: AiStage;
  occurred_at: string;
  /** Keyed hashes: stable for the same sale / merchant, meaningless to anyone without the key. */
  tx: string;
  merchant: string;
  features: Record<string, string | number | boolean | null>;
}

const token = (key: string, kind: string, value: string) => createHmac("sha256", key).update(`${kind}:${value}`).digest("hex").slice(0, 32);

/** The amount as a band: enough to spot "unusually large for this merchant" without the exact figure. */
export function amountBand(amount: number): string {
  if (amount < 100) return "<100";
  if (amount < 500) return "100-499";
  if (amount < 5_000) return "500-4999";
  if (amount < 10_000) return "5000-9999";
  if (amount < 50_000) return "10000-49999";
  return "50000+";
}

/** Pure: the event for one stage of one sale, pseudonymised. Unit tested to hold no identifying field. */
export function buildAiEvent(stage: AiStage, tx: AiTxInput, opts: { key: string; level: Exclude<AiLevel, "off">; now?: Date; eventId?: string }): AiEvent {
  const now = opts.now ?? new Date();
  const eat = new Date(now.getTime() + 3 * 3_600_000); // Addis Ababa time, for "what hour is it there"
  const amount = Number(tx.amount);
  const features: AiEvent["features"] = {
    amount_band: amountBand(amount),
    hour_eat: eat.getUTCHours(),
    weekday_eat: eat.getUTCDay(),
    channel: tx.source ?? "TERMINAL",
    ride: !!tx.ride_session_id,
    institution: tx.rail ?? null,
    provider: tx.rail_provider ?? null,
    method: tx.settlement_method ?? null,
    payer_app: tx.payer_app ?? null,
    tip: Number(tx.tip_amount ?? 0) > 0,
    latency_ms: stage === "SETTLED" ? (tx.latency_ms ?? null) : null,
  };
  if (opts.level === "full") {
    features.amount = amount;
    features.tip_amount = Number(tx.tip_amount ?? 0);
    features.fee_total = tx.fee_ft == null ? null : Number(tx.fee_ft);
  }
  return { v: 1, event_id: opts.eventId ?? randomUUID(), stage, occurred_at: now.toISOString(), tx: token(opts.key, "tx", tx.id), merchant: token(opts.key, "merchant", tx.merchant_id), features };
}

// ------------------------------------------------------------------ signing (both directions)
export const SIGNATURE_WINDOW_S = 300;

/** `sha256=<hmac of "<timestamp>.<body>">`: the timestamp is signed too, so a captured request cannot be replayed later. */
export const signBody = (secret: string, timestamp: string, body: string) => `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

export function verifySignature(secret: string, timestamp: string | null, signature: string | null, body: string, nowMs = Date.now()): boolean {
  if (!timestamp || !signature || !/^\d{9,13}$/.test(timestamp)) return false;
  const ts = Number(timestamp) * (timestamp.length <= 10 ? 1000 : 1);
  if (Math.abs(nowMs - ts) > SIGNATURE_WINDOW_S * 1000) return false;
  const want = Buffer.from(signBody(secret, timestamp, body));
  const got = Buffer.from(signature);
  return want.length === got.length && timingSafeEqual(want, got);
}

// ------------------------------------------------------------------ the outbox
/** Run after the response has been sent (so the payment never waits); where that is not possible (a script, a test), run it now. */
function defer(fn: () => Promise<void>) {
  const safe = () => fn().catch((e) => console.error("[ai-events]", (e as Error).message));
  try {
    after(safe);
  } catch {
    void safe();
  }
}

/** Record one stage of a sale for the AI layer. Never throws, never blocks, and does nothing at all when the layer is off. */
export function emitAiEvent(admin: SupabaseClient, stage: AiStage, tx: AiTxInput, env: Env = process.env): void {
  try {
    if (!aiEnabled(env)) return;
    const event = buildAiEvent(stage, tx, { key: env.AI_PSEUDONYM_KEY as string, level: aiLevel(env) as "features" | "full" });
    defer(async () => {
      const { error } = await admin.from("ai_event_outbox").insert({ stage, payload: event, tx_ref: event.tx, transaction_id: tx.id });
      if (error) return console.error("[ai-events] outbox:", error.message);
      await flushAiOutbox(admin, 25, env); // try to deliver at once; anything that fails stays queued for the next sweep
    });
  } catch (e) {
    console.error("[ai-events]", (e as Error).message);
  }
}

const backoffMs = (attempts: number) => Math.min(3_600_000, 15_000 * 2 ** Math.min(attempts, 10));

/** Send queued events to the AI layer. Returns how many were delivered. Safe to call from a cron job at any time. */
export async function flushAiOutbox(admin: SupabaseClient, limit = 100, env: Env = process.env): Promise<{ sent: number; failed: number; pending: number }> {
  if (!aiEnabled(env)) return { sent: 0, failed: 0, pending: 0 };
  const { data: rows, error } = await admin
    .from("ai_event_outbox")
    .select("id, payload, attempts")
    .is("sent_at", null)
    .lte("next_attempt_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error || !rows?.length) return { sent: 0, failed: 0, pending: 0 };

  const body = JSON.stringify({ events: rows.map((r) => r.payload) });
  const ts = String(Math.floor(Date.now() / 1000));
  const ids = rows.map((r) => r.id as string);
  try {
    const res = await fetch(env.AI_EVENT_SINK_URL as string, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-2pay-timestamp": ts, "x-2pay-signature": signBody(env.AI_EVENT_SECRET as string, ts, body) },
      body,
      signal: AbortSignal.timeout(4000),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`the AI layer answered ${res.status}`);
    await admin.from("ai_event_outbox").update({ sent_at: new Date().toISOString(), last_error: null }).in("id", ids);
    return { sent: rows.length, failed: 0, pending: 0 };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 200);
    // each event waits longer than the last time before it is tried again
    for (const r of rows) {
      await admin.from("ai_event_outbox").update({ attempts: Number(r.attempts) + 1, next_attempt_at: new Date(Date.now() + backoffMs(Number(r.attempts))).toISOString(), last_error: msg }).eq("id", r.id);
    }
    return { sent: 0, failed: rows.length, pending: rows.length };
  }
}
