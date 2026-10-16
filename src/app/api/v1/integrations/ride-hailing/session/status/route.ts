import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { SESSION_TOKEN_RE, sha256 } from "@/lib/ride";
import { PAID_STATES, bad, safeTx, sessionByToken, sessionForDriver, statusOf } from "@/lib/ride-server";
import { requireDriver } from "@/lib/driver-server";
import { isUuid } from "@/lib/settlement";
import { clientIp } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const MAX_WAIT_S = 7;
const CHECK_EVERY_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The driver's phone asks "has this ride been paid?" with its checkout link (GET ?session_token=...&wait=7&sig=...) or, when the driver is
 * signed in to 2Pay and the app caught the ride itself, with the ride id (GET ?ride_id=...&wait=7&sig=...).
 * The request is HELD until the answer changes, so a payment reaches the driver's screen about one network hop after it clears
 * (the same held-request technique as the cashier terminal). Without `wait` it answers at once. `x-status-sig` is the signature to
 * send back as `sig` next time.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const token = q.get("session_token") ?? "";
  const rideId = q.get("ride_id") ?? "";
  if (rideId ? !isUuid(rideId) : !SESSION_TOKEN_RE.test(token)) return bad("This checkout link is not valid.", 400, { code: "SESSION_INVALID" });
  const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(q.get("wait")) || 0));
  const known = q.get("sig") ?? "";

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
  if (!(await rateLimit(admin, `ride:status:${clientIp(req)}`, 240, 60))) return bad("Too many requests.", 429);
  let s;
  if (rideId) {
    const who = await requireDriver();
    if (!who.ok) return who.res;
    s = await sessionForDriver(admin, rideId, who.merchantId);
  } else {
    s = await sessionByToken(admin, token);
  }
  if (!s) return bad("This checkout link is not valid.", 404, { code: "SESSION_INVALID" });

  const read = async () => {
    const { data } = await admin.from("transactions").select("*").eq("ride_session_id", s.id).order("created_at", { ascending: false });
    const rows = data ?? [];
    const paid = rows.find((r) => PAID_STATES.includes(r.status as string)) ?? null;
    const processing = rows.some((r) => r.status === "PROCESSING");
    const state = paid ? "PAID" : statusOf(s);
    const sig = `${state}|${processing ? "P" : "-"}|${paid?.id ?? ""}`;
    return { state, processing, paid, sig };
  };

  let cur = await read();
  if (wait > 0 && cur.sig === known) {
    const deadline = Date.now() + wait * 1000;
    while (Date.now() < deadline && !req.signal.aborted) {
      await sleep(CHECK_EVERY_MS);
      cur = await read();
      if (cur.sig !== known) break;
    }
  }
  if (cur.paid && s.status === "OPEN") await admin.from("ride_sessions").update({ status: "PAID", paid_at: new Date().toISOString() }).eq("id", s.id).eq("status", "OPEN");
  return NextResponse.json(
    { status: cur.state, processing: cur.processing, paid: cur.paid ? safeTx(cur.paid as Record<string, unknown>) : null },
    { headers: { "Cache-Control": "private, no-store", "x-status-sig": cur.sig } },
  );
}
