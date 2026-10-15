import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { aiEnabled, flushAiOutbox } from "@/lib/ai-events";
import { safeEqual } from "@/lib/watchdog";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Safety net for the AI event outbox: delivers anything that was not sent at once (the AI layer was slow or unreachable). Normal delivery
 * happens right after each sale; this sweep only catches what is left. Protected by CRON_SECRET like the other scheduled jobs.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secret || !given || !safeEqual(secret, given)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!aiEnabled()) return NextResponse.json({ enabled: false });
  try {
    const admin = getAdminClient();
    const r = await flushAiOutbox(admin, 200);
    return NextResponse.json({ enabled: true, ...r });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
