import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireSession, isAdminPhone } from "@/lib/guard";
import { authEnforced } from "@/lib/auth";
import type { Merchant } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Merchants with their public fields plus the institution NAMES of their active routing (never account numbers).
 * Test mode lists everyone. When enforced, a merchant sees only themselves and an admin sees all.
 */
export async function GET() {
  const guard = await requireSession();
  if (!guard.ok) return guard.res;

  try {
    let query = getAdminClient()
      .from("merchants")
      .select("id, business_name, category, terminal_id, location, active_bank, active_wallet")
      .order("business_name");
    if (authEnforced() && !isAdminPhone(guard.session?.ph)) query = query.eq("id", guard.session!.mid);

    const { data, error } = await query;
    if (error) {
      console.error("[merchants GET]", error.message);
      return NextResponse.json({ error: "Could not load merchants" }, { status: 500 });
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
    return NextResponse.json(merchants, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
