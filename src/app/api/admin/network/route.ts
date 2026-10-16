import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * What the network is made of, for the admin hub's node view: how many businesses, shop-QR stands, team phones bound to the 2Pay app
 * (the phones that act as NFC tags), individual drivers (and how many are linked to a ride-hailing company), ride-hailing companies and the drivers who took a checkout in the last 24 hours. Counted by the
 * database, so it is right however large the network grows. Counts only: no names, numbers or secrets.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  try {
    const { data, error } = await getAdminClient().rpc("admin_network_counts");
    if (error || !data) return NextResponse.json({ error: "Could not load the network. Has supabase/v2_7.sql been run?" }, { status: 500 });
    const c = data as { merchants: number; shop_qr_stands: number; app_devices: number; by_role: Record<string, number>; ride_partners: number; drivers?: number; linked_drivers?: number; ride_drivers_24h: number; ride_checkouts_24h: number };
    return NextResponse.json(
      {
        merchants: c.merchants,
        shop_qr_stands: c.shop_qr_stands,
        app_devices: c.app_devices,
        app_devices_by_role: { WAITER: c.by_role.WAITER ?? 0, CASHIER: c.by_role.CASHIER ?? 0, MANAGER: c.by_role.MANAGER ?? 0 },
        drivers: c.drivers ?? 0,
        linked_drivers: c.linked_drivers ?? 0,
        ride_partners: c.ride_partners,
        ride_drivers_24h: c.ride_drivers_24h,
        ride_checkouts_24h: c.ride_checkouts_24h,
        ride_available: true,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
