import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireDriver } from "@/lib/driver-server";
import { PAID_STATES } from "@/lib/ride-server";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const MAX_WAIT_S = 7;
const CHECK_EVERY_MS = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The ride waiting for this driver, if any: how the driver's 2Pay app CATCHES a finished trip by itself. The company's server starts a ride for a
 * linked driver the moment the trip closes; the app, signed in and open, holds this request and gets the answer as soon as the ride exists, then
 * opens the fare. GET ?wait=7&sig=... is held until the answer changes (the same held-request technique as the terminal); `x-ride-sig` is the
 * value to send back as `sig`. The ride is the driver's own: they see only rides addressed to their account.
 * (A phone that is closed or asleep needs a push notification, which is a separate piece: see docs/RIDE_AND_PRICING_V2_5.md.)
 */
export async function GET(req: Request) {
  const who = await requireDriver();
  if (!who.ok) return who.res;
  const q = new URL(req.url).searchParams;
  const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(q.get("wait")) || 0));
  const known = q.get("sig") ?? "";
  try {
    const admin = getAdminClient();
    const read = async () => {
      const { data } = await admin
        .from("ride_sessions")
        .select("id, partner_id, amount, currency, expires_at, created_at")
        .eq("driver_merchant_id", who.merchantId)
        .eq("status", "OPEN")
        .gte("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(5);
      for (const s of data ?? []) {
        const { data: txs } = await admin.from("transactions").select("status").eq("ride_session_id", s.id);
        if ((txs ?? []).some((t) => PAID_STATES.includes(t.status as string))) continue; // already paid: not waiting any more
        const { data: p } = await admin.from("ride_partners").select("name").eq("id", s.partner_id).maybeSingle();
        return { id: s.id as string, amount: Number(s.amount), currency: s.currency as string, company: (p?.name as string | undefined) ?? "Ride", expires_at: s.expires_at as string };
      }
      return null;
    };
    let ride = await read();
    if (wait > 0 && (ride?.id ?? "") === known) {
      const deadline = Date.now() + wait * 1000;
      while (Date.now() < deadline && !req.signal.aborted) {
        await sleep(CHECK_EVERY_MS);
        ride = await read();
        if ((ride?.id ?? "") !== known) break;
      }
    }
    return NextResponse.json({ ride }, { headers: { "Cache-Control": "private, no-store", "x-ride-sig": ride?.id ?? "" } });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
