import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import { authEnforced } from "@/lib/auth";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { isAdminPhone, roleOf, staffIdOf } from "@/lib/guard";
import { railMode } from "@/lib/rails";
import type { Merchant } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Everything the merchant portal needs to draw its first screen, in ONE request: who is signed in, which businesses
 * they may see (with the NAMES of their active institutions, never account numbers), and which one to open.
 * Before this the app asked three times in a row (merchants, session, session again), and every round trip costs a
 * full network hop. The answers are the same ones /api/merchants and /api/auth/me give, so access rules are unchanged.
 */
export async function GET() {
  const noStore = { "Cache-Control": "private, no-store" };
  const base = {
    enforced: authEnforced(),
    merchant: null as null | { id: string; business_name: string; terminal_id: string },
    admin: false,
    role: "OWNER" as "OWNER" | "CASHIER" | "WAITER" | "MANAGER",
    staff: null as null | { id: string; name: string; team_no: string | null },
    railMode: railMode(),
    merchants: [] as Merchant[],
    defaultMerchantId: "",
  };
  const session = await verifySession((await cookies()).get(SESSION_COOKIE)?.value, process.env.SESSION_SECRET);
  if (authEnforced() && !session) return NextResponse.json({ error: "Authentication required" }, { status: 401, headers: noStore });

  try {
    const admin = getAdminClient();
    let list = admin.from("merchants").select("id, business_name, category, terminal_id, location, active_bank, active_wallet").neq("kind", "RIDE_PARTNER").order("business_name");
    if (authEnforced() && !isAdminPhone(session?.ph)) list = list.eq("id", session!.mid);

    const sid = staffIdOf(session);
    const [{ data, error }, staffRes] = await Promise.all([
      list,
      sid ? admin.from("merchant_staff").select("id, name, team_no").eq("id", sid).eq("merchant_id", session!.mid).eq("active", true).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    if (error) {
      console.error("[portal]", error.message);
      return NextResponse.json({ error: "Could not load merchants" }, { status: 500, headers: noStore });
    }
    // Named fields only (never a spread): whatever else a row might carry can never reach the browser.
    const merchants: Merchant[] = (data ?? []).map((m) => ({
      id: m.id,
      business_name: m.business_name,
      category: m.category,
      terminal_id: m.terminal_id,
      location: m.location ?? null,
      routing: { bank: m.active_bank?.institution ?? null, wallet: m.active_wallet?.institution ?? null },
    }));
    const own = session ? merchants.find((m) => m.id === session.mid) : undefined;
    return NextResponse.json(
      {
        ...base,
        merchants,
        merchant: own ? { id: own.id, business_name: own.business_name, terminal_id: own.terminal_id } : null,
        admin: isAdminPhone(session?.ph),
        role: session ? roleOf(session) : "OWNER",
        staff: staffRes.data ?? null,
        defaultMerchantId: own?.id ?? merchants[0]?.id ?? "",
      },
      { headers: noStore },
    );
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500, headers: noStore });
    throw e;
  }
}