import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { dataAllowed } from "@/lib/deploy";

let cached: SupabaseClient | null = null;

/**
 * Service-role client for trusted server code only (API route handlers).
 * It bypasses RLS, so never import this from a "use client" module and never
 * expose SUPABASE_SERVICE_ROLE_KEY via a NEXT_PUBLIC_ variable.
 */
export function getAdminClient(): SupabaseClient {
  // The UI deployment (DEPLOY_ROLE=ui) is not allowed to reach data at all, even if credentials were ever put there by mistake.
  if (!dataAllowed()) throw new AdminConfigError();
  if (cached) return cached;
  // SUPABASE_URL is the server-side name (for an in-country database); the older NEXT_PUBLIC_ name still works.
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
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
