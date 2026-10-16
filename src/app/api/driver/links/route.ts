import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireDriver } from "@/lib/driver-server";

export const dynamic = "force-dynamic";

/**
 * The ride-hailing companies this driver is linked to or has been asked to link with: waiting for them to accept (PENDING) or active.
 * Only their own links. A driver may be linked to several companies at once.
 */
export async function GET() {
  const who = await requireDriver();
  if (!who.ok) return who.res;
  try {
    const admin = getAdminClient();
    const { data } = await admin.from("ride_driver_links").select("id, partner_id, driver_ref, status, created_at, confirmed_at").eq("merchant_id", who.merchantId).in("status", ["PENDING", "ACTIVE"]).order("created_at", { ascending: false }).limit(50);
    const ids = [...new Set((data ?? []).map((l) => l.partner_id as string))];
    const names = new Map<string, string>();
    if (ids.length) {
      const { data: ps } = await admin.from("ride_partners").select("id, name").in("id", ids);
      for (const p of ps ?? []) names.set(p.id as string, p.name as string);
    }
    return NextResponse.json(
      (data ?? []).map((l) => ({ id: l.id, company: names.get(l.partner_id as string) ?? "A ride-hailing company", driver_ref: l.driver_ref, status: l.status, since: l.confirmed_at ?? l.created_at })),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
