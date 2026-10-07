import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/** Shared client (browser + server). Auth session persistence is unnecessary for the prototype. */
export const supabase = createClient(url, anon, {
  auth: { persistSession: false, autoRefreshToken: false },
});
