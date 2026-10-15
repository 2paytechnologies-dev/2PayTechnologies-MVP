import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { aiEnabled, verifySignature } from "@/lib/ai-events";
import { clientIp } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const err = (error: string, status: number) => NextResponse.json({ error }, { status });

/**
 * Risk scores coming back from the AI layer: POST { scores: [{ tx_ref, score (0-100), model, reasons? }] }, signed like the events
 * (x-2pay-timestamp + x-2pay-signature over "<timestamp>.<body>" with the shared secret, within five minutes). `tx_ref` is the pseudonymous
 * reference the event carried; the score is stored beside that sale. A score changes nothing about a payment by itself: it is information
 * for the Watchdog and the admin hub.
 */
export async function POST(req: Request) {
  if (!aiEnabled()) return err("The AI layer is not switched on", 404);
  const raw = await req.text();
  if (raw.length > 200_000) return err("Too large", 413);
  if (!verifySignature(process.env.AI_EVENT_SECRET as string, req.headers.get("x-2pay-timestamp"), req.headers.get("x-2pay-signature"), raw)) return err("Bad signature", 401);
  let body: { scores?: { tx_ref?: unknown; score?: unknown; model?: unknown; reasons?: unknown }[] };
  try {
    body = JSON.parse(raw);
  } catch {
    return err("Invalid JSON", 400);
  }
  const list = Array.isArray(body.scores) ? body.scores.slice(0, 100) : [];
  if (!list.length) return err("scores is required", 400);

  try {
    const admin = getAdminClient();
    if (!(await rateLimit(admin, `ai:score:${clientIp(req)}`, 600, 60))) return err("Too many requests", 429);
    let accepted = 0;
    for (const s of list) {
      const ref = typeof s.tx_ref === "string" && /^[0-9a-f]{32}$/.test(s.tx_ref) ? s.tx_ref : null;
      const score = typeof s.score === "number" && Number.isFinite(s.score) ? Math.round(s.score) : NaN;
      const model = typeof s.model === "string" ? s.model.slice(0, 60) : "";
      if (!ref || !(score >= 0 && score <= 100) || !model) continue;
      const { data: ev } = await admin.from("ai_event_outbox").select("transaction_id").eq("tx_ref", ref).limit(1).maybeSingle();
      const reasons = Array.isArray(s.reasons) ? s.reasons.filter((r): r is string => typeof r === "string").slice(0, 10).map((r) => r.slice(0, 120)) : [];
      const { error } = await admin.from("ai_scores").insert({ tx_ref: ref, transaction_id: ev?.transaction_id ?? null, score, model, reasons });
      if (!error) accepted++;
    }
    return NextResponse.json({ accepted }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AdminConfigError) return err("Server misconfigured", 500);
    throw e;
  }
}
