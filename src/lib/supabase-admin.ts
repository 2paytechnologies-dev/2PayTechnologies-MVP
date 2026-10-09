import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/**
 * Service-role client for trusted server code only (API route handlers).
 * It bypasses RLS, so never import this from a "use client" module and never
 * expose SUPABASE_SERVICE_ROLE_KEY via a NEXT_PUBLIC_ variable.
 */
export function getAdminClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new AdminConfigError();
  cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}

export class AdminConfigError extends Error {
  constructor() {
    super("SUPABASE_SERVICE_ROLE_KEY is not configured");
    this.name = "AdminConfigError";
  }
}
