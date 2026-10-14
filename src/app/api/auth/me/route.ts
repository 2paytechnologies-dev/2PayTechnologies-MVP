import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import { authEnforced } from "@/lib/auth";
import { getAdminClient } from "@/lib/supabase-admin";
import { isAdminPhone, roleOf, staffIdOf } from "@/lib/guard";
import { railMode } from "@/lib/rails";

export const dynamic = "force-dynamic";

/** Current session (if any) plus whether authentication is being enforced. Never errors for anonymous callers. */
export async function GET() {
  const base = { enforced: authEnforced(), merchant: null as null | { id: string; business_name: string; terminal_id: string }, admin: false, role: "OWNER" as "OWNER" | "CASHIER" | "WAITER" | "MANAGER", staff: null as null | { id: string; name: string; team_no: string | null }, railMode: railMode() };
  const session = await verifySession((await cookies()).get(SESSION_COOKIE)?.value, process.env.SESSION_SECRET);
  const noStore = { headers: { "Cache-Control": "private, no-store" } };
  if (!session) return NextResponse.json(base, noStore);

  try {
    const admin = getAdminClient();
    const { data } = await admin.from("merchants").select("id, business_name, terminal_id").eq("id", session.mid).maybeSingle();
    // A team member also gets their own name and team number, so their terminal can say who is signed in.
    let staff = null as null | { id: string; name: string; team_no: string | null };
    if (staffIdOf(session)) {
      const { data: s } = await admin.from("merchant_staff").select("id, name, team_no").eq("id", session.sid!).eq("merchant_id", session.mid).eq("active", true).maybeSingle();
      staff = s ?? null;
    }
    return NextResponse.json({ ...base, merchant: data ?? null, admin: isAdminPhone(session.ph), role: roleOf(session), staff }, noStore);
  } catch {
    return NextResponse.json(base, noStore);
  }
}
