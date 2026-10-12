import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionPayload } from "@/lib/session";

/** The caller's IP as seen behind Vercel's proxy (first hop of x-forwarded-for). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "unknown").trim().slice(0, 64);
}

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  /** Overrides the session's merchant (for example an admin acting on a merchant). */
  merchantId?: string | null;
}

/**
 * Append-only record of sensitive actions: who, what, on what, from where. Never throws and never blocks the
 * action it describes: an audit failure is logged, not surfaced to the user.
 */
export async function audit(admin: SupabaseClient, session: SessionPayload | null, req: Request, entry: AuditEntry): Promise<void> {
  try {
    const { error } = await admin.from("audit_log").insert({
      actor_phone: session?.ph ?? null,
      actor_merchant_id: entry.merchantId ?? session?.mid ?? null,
      role: session?.rl ?? (session ? "OWNER" : null),
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      ip: clientIp(req),
      details: entry.details ?? {},
    });
    if (error) console.error("[audit] insert failed:", error.message);
  } catch (e) {
    console.error("[audit] failed:", (e as Error).message);
  }
}
