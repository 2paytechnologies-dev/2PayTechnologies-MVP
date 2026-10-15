import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase-admin";
import { railMode } from "@/lib/rails";
import { authEnforced, sessionSecret } from "@/lib/auth";
import { smsConfigured } from "@/lib/sms";
import { APP_VERSION } from "@/lib/brand";
import { encryptionActive } from "@/lib/fieldcrypt";
import { faydaConfigured } from "@/lib/fayda";
import { ekycMode, faydaRequired } from "@/lib/fayda-ekyc";
import { deployRole } from "@/lib/deploy";
import { aiEnabled } from "@/lib/ai-events";
import { checkSchema, type SchemaStatus } from "@/lib/schema-check";

export const dynamic = "force-dynamic";

/**
 * For uptime monitors (point UptimeRobot, Better Stack, etc. at /api/health). Returns 200 when the app can reach its
 * database and 503 otherwise. Reports configuration STATE only (booleans and modes), never any secret or value.
 */
export async function GET() {
  // The screens-only deployment has no database on purpose: say so instead of reporting an outage.
  if (deployRole() === "ui") return NextResponse.json({ ok: true, version: APP_VERSION, role: "ui", database: "none (screens only; the data lives on the core server)", time: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
  let db = false;
  let schema: SchemaStatus = { ok: false, missing: [] };
  try {
    const admin = getAdminClient();
    const { error } = await admin.from("merchants").select("id", { head: true, count: "exact" }).limit(1);
    db = !error;
    if (db) schema = await checkSchema(admin);
  } catch {
    db = false;
  }
  const ok = db && schema.ok;
  const body = {
    ok,
    version: APP_VERSION,
    role: deployRole(),
    time: new Date().toISOString(),
    database: db ? "ok" : "unreachable",
    // "outdated" lists the migration files in supabase/ still to run (names only).
    schema: db ? (schema.ok ? "ok" : "outdated") : "unknown",
    migrationsToRun: schema.missing,
    rail: { mode: railMode(), provider: process.env.RAIL_PROVIDER ?? "arifpay" },
    auth: { enforced: authEnforced(), sessionSecretSet: !!sessionSecret(), smsConfigured: smsConfigured() },
    // V2.4: whether account numbers/TINs are encrypted at rest, and whether national ID (Fayda) sign-in is configured.
    security: { fieldEncryption: encryptionActive(), faydaConfigured: faydaConfigured(), faydaEkyc: ekycMode() ?? "off", faydaRequired: faydaRequired(), aiEvents: aiEnabled() ? "on" : "off" },
  };
  return NextResponse.json(body, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
