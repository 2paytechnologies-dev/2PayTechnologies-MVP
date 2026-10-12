import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Database-backed fixed-window rate limit (works across serverless instances, unlike in-memory counters).
 * Returns true while `key` is within `limit` hits per `windowSeconds`.
 * If the limiter itself fails it FAILS OPEN by default so a database hiccup never stops a customer paying;
 * pass `failClosed: true` for abuse-sensitive endpoints.
 */
export async function rateLimit(
  admin: SupabaseClient,
  key: string,
  limit: number,
  windowSeconds: number,
  opts: { failClosed?: boolean } = {},
): Promise<boolean> {
  try {
    const { data, error } = await admin.rpc("rate_limit_hit", { p_key: key.slice(0, 200), p_limit: limit, p_window_s: windowSeconds });
    if (error) throw new Error(error.message);
    return data === true;
  } catch (e) {
    console.error("[ratelimit] limiter error:", (e as Error).message);
    return !opts.failClosed;
  }
}
