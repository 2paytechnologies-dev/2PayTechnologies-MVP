import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
/** The longest a held request may live (seconds). The wait below stays well inside it. */
export const maxDuration = 15;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_WAIT_S = 7;
const CHECK_EVERY_MS = 150;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const signature = (rows: { id: string; status: string }[]) => rows.map((r) => `${r.id}:${r.status}`).sort().join("|");

/**
 * Status of specific pay nodes, for the terminal's "customer paid" detection.
 * The unguessable pay tokens are the credential, so no session is needed: the terminal only ever asks about
 * tokens it just minted. Returns only what the terminal needs.
 *
 * Instant by waiting on the server instead of asking again and again: with `wait=<seconds>` and `sig=<the x-status-sig
 * header of the last answer>` the request is HELD and answered the moment any sale changes (checked every 200 ms on the
 * server), or after `wait` seconds with the unchanged state. The terminal sees a payment about a fifth of a second
 * after it clears, instead of up to a whole polling interval later. Without `wait` it answers at once, as before.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("tokens") ?? "";
  const tokens = raw.split(",").map((t) => t.trim()).filter(Boolean);
  if (!tokens.length || tokens.length > 12 || !tokens.every((t) => UUID.test(t))) {
    return NextResponse.json({ error: "tokens must be 1-12 comma-separated uuids" }, { status: 400 });
  }
  const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(url.searchParams.get("wait")) || 0));
  const known = url.searchParams.get("sig") ?? "";

  try {
    const admin = getAdminClient();
    const read = async () => {
      const { data, error } = await admin
        .from("transactions")
        .select("id, token, status, amount, tip_amount, currency, latency_ms, rail, settlement_method, settled_at")
        .in("token", tokens);
      if (error) throw new Error(error.message);
      return data ?? [];
    };

    let rows = await read();
    if (wait > 0 && signature(rows) === known) {
      const deadline = Date.now() + wait * 1000;
      while (Date.now() < deadline && !req.signal.aborted) {
        await sleep(CHECK_EVERY_MS);
        rows = await read();
        if (signature(rows) !== known) break;
      }
    }
    return NextResponse.json(rows, { headers: { "Cache-Control": "private, no-store", "x-status-sig": signature(rows) } });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    console.error("[transactions/status]", (e as Error).message);
    return NextResponse.json({ error: "Could not load status" }, { status: 500 });
  }
}