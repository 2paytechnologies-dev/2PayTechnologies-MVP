import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Smart routing across rails. Operators state a preference order per institution (or a default); the router keeps
 * that order but moves a provider that is currently failing to the back, so payers are sent to a working rail and
 * the preferred one is retried automatically once it recovers. With one registered provider it is a no-op.
 *
 * RAIL_ROUTING (JSON), for example:
 *   {"default":["arifpay"],"Telebirr":["telebirr","arifpay"],"Awash Bank":["awashbank","arifpay"]}
 */
export type RoutingConfig = Record<string, string[]>;

export interface ProviderHealth {
  /** Session-creation attempts in the last 10 minutes, and how many of them failed. */
  recentAttempts: number;
  recentFailures: number;
  /** Outcomes of real payments in the last 24 hours. */
  settled: number;
  failed: number;
}

export const EMPTY_HEALTH: ProviderHealth = { recentAttempts: 0, recentFailures: 0, settled: 0, failed: 0 };

/** Parse RAIL_ROUTING. Anything malformed is ignored (the default provider is then used). */
export function parseRouting(raw: string | undefined): RoutingConfig {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: RoutingConfig = {};
    for (const [k, list] of Object.entries(v as Record<string, unknown>)) {
      if (Array.isArray(list)) out[k] = list.filter((p): p is string => typeof p === "string");
    }
    return out;
  } catch {
    return {};
  }
}

/** Providers allowed for an institution, in operator preference order, restricted to registered adapters. */
export function candidatesFor(institution: string, cfg: RoutingConfig, registered: string[], fallbackDefault: string): string[] {
  const wanted = cfg[institution] ?? cfg.default ?? [fallbackDefault];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of wanted) {
    if (registered.includes(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** A provider is "unhealthy" when it is clearly failing right now. Thresholds avoid reacting to a single blip. */
export function isUnhealthy(h: ProviderHealth): boolean {
  const sessionTrouble = h.recentAttempts >= 5 && h.recentFailures / h.recentAttempts >= 0.5;
  const outcomes = h.settled + h.failed;
  const paymentTrouble = outcomes >= 10 && h.failed / outcomes >= 0.6;
  return sessionTrouble || paymentTrouble;
}

/** Keep the operator's order, but try healthy providers first. Unhealthy ones stay as a last resort. */
export function rankProviders(candidates: string[], health: Record<string, ProviderHealth>): string[] {
  const healthy = candidates.filter((c) => !isUnhealthy(health[c] ?? EMPTY_HEALTH));
  const sick = candidates.filter((c) => isUnhealthy(health[c] ?? EMPTY_HEALTH));
  return [...healthy, ...sick];
}

/** Recent health of each provider, from the attempts log and payment outcomes. Never throws (routing falls back to the configured order). */
export async function loadHealth(admin: SupabaseClient, providers: string[]): Promise<Record<string, ProviderHealth>> {
  const out: Record<string, ProviderHealth> = Object.fromEntries(providers.map((p) => [p, { ...EMPTY_HEALTH }]));
  try {
    const tenMin = new Date(Date.now() - 10 * 60_000).toISOString();
    const day = new Date(Date.now() - 86_400_000).toISOString();
    const [att, tx] = await Promise.all([
      admin.from("rail_attempts").select("provider, ok").gte("created_at", tenMin).limit(1000),
      admin.from("transactions").select("rail_provider, status").not("rail_provider", "is", null).in("status", ["SETTLED", "FAILED"]).gte("created_at", day).limit(2000),
    ]);
    for (const a of att.data ?? []) {
      const h = out[a.provider as string];
      if (!h) continue;
      h.recentAttempts++;
      if (!a.ok) h.recentFailures++;
    }
    for (const t of tx.data ?? []) {
      const h = out[t.rail_provider as string];
      if (!h) continue;
      if (t.status === "SETTLED") h.settled++;
      else h.failed++;
    }
  } catch (e) {
    console.error("[router] health unavailable:", (e as Error).message);
  }
  return out;
}

export async function recordAttempt(admin: SupabaseClient, provider: string, institution: string, ok: boolean, error?: string): Promise<void> {
  try {
    await admin.from("rail_attempts").insert({ provider, institution, ok, error: error ? error.slice(0, 300) : null });
  } catch {
    /* health tracking is best effort */
  }
}
