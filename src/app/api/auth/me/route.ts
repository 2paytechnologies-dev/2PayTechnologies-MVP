import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import { authEnforced } from "@/lib/auth";
import { getAdminClient } from "@/lib/supabase-admin";
import { isAdminPhone } from "@/lib/guard";

export const dynamic = "force-dynamic";

/** Current session (if any) plus whether authentication is being enforced. Never errors for anonymous callers. */
export async function GET() {
  const base = { enforced: authEnforced(), merchant: null as null | { id: string; business_name: string; terminal_id: string }, admin: false };
  const session = await verifySession((await cookies()).get(SESSION_COOKIE)?.value, process.env.SESSION_SECRET);
  if (!session) return NextResponse.json(base);

  try {
    const { data } = await getAdminClient().from("merchants").select("id, business_name, terminal_id").eq("id", session.mid).maybeSingle();
    return NextResponse.json({ ...base, merchant: data ?? null, admin: isAdminPhone(session.ph) });
  } catch {
    return NextResponse.json(base);
  }
}
