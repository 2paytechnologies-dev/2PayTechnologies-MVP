import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getAdminClient } from "@/lib/supabase-admin";
import { MERCHANT_PUBLIC_COLUMNS, type Merchant } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Merchants with their public fields plus the institution names of their active routing (never account numbers). */
export async function GET() {
  const { data, error } = await supabase.from("merchants").select(MERCHANT_PUBLIC_COLUMNS).order("business_name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const merchants = (data ?? []) as Merchant[];
  try {
    const { data: routing } = await getAdminClient().from("merchants").select("id, active_bank, active_wallet");
    const byId = new Map((routing ?? []).map((r) => [r.id as string, r]));
    for (const m of merchants) {
      const r = byId.get(m.id);
      if (r) m.routing = { bank: r.active_bank?.institution ?? null, wallet: r.active_wallet?.institution ?? null };
    }
  } catch {
    /* routing stays undefined: the server re-checks it when a pay node is created */
  }
  return NextResponse.json(merchants);
}
