import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { clientIp } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";
import { currentSession } from "@/lib/guard";

export const dynamic = "force-dynamic";

const clip = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);

/**
 * Receives errors from the browser and the Android app so problems are seen without waiting for a merchant to call.
 * Public (an error can happen before sign-in), so it is rate limited per IP and every field is length-capped.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const message = clip(body?.message, 500);
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });
  try {
    const admin = getAdminClient();
    if (!(await rateLimit(admin, `err:${clientIp(req)}`, 20, 60))) return NextResponse.json({ error: "Too many reports" }, { status: 429 });
    const session = await currentSession().catch(() => null);
    await admin.from("app_errors").insert({
      source: clip(body?.source, 40) ?? "web",
      message,
      stack: clip(body?.stack, 2000),
      url: clip(body?.url, 300),
      user_agent: clip(req.headers.get("user-agent"), 300),
      merchant_id: session?.mid ?? null,
    });
    return NextResponse.json({ ok: true }, { status: 202 });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    return NextResponse.json({ ok: false }, { status: 202 }); // telemetry must never produce errors of its own
  }
}
