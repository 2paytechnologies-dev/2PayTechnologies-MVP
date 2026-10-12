import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase-admin";
import { railMode } from "@/lib/rails";
import { authEnforced, sessionSecret } from "@/lib/auth";
import { smsConfigured } from "@/lib/sms";
import { APP_VERSION } from "@/lib/brand";

export const dynamic = "force-dynamic";

/**
 * For uptime monitors (point UptimeRobot, Better Stack, etc. at /api/health). Returns 200 when the app can reach its
 * database and 503 otherwise. Reports configuration STATE only (booleans and modes), never any secret or value.
 */
export async function GET() {
  let db = false;
  try {
    const { error } = await getAdminClient().from("merchants").select("id", { head: true, count: "exact" }).limit(1);
    db = !error;
  } catch {
    db = false;
  }
  const body = {
    ok: db,
    version: APP_VERSION,
    time: new Date().toISOString(),
    database: db ? "ok" : "unreachable",
    rail: { mode: railMode(), provider: process.env.RAIL_PROVIDER ?? "arifpay" },
    auth: { enforced: authEnforced(), sessionSecretSet: !!sessionSecret(), smsConfigured: smsConfigured() },
  };
  return NextResponse.json(body, { status: db ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
