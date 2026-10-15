import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/guard";

export const dynamic = "force-dynamic";

const DAY = 86_400_000;

/**
 * What the network is made of, for the admin hub's node view: how many businesses, shop-QR stands, team phones bound to the
 * 2Pay app (the phones that act as NFC tags), ride-hailing partners and the drivers who took a checkout in the last 24 hours.
 * Counts only: no names, numbers or secrets.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  try {
    const admin = getAdminClient();
    const since = new Date(Date.now() - DAY).toISOString();
    const [merchants, staff, partners, rides] = await Promise.all([
      admin.from("merchants").select("id, static_qr_enabled").limit(5000),
      admin.from("merchant_staff").select("id, role, active, device_id_hash, activated_at").limit(5000),
      admin.from("ride_partners").select("id, active").limit(500),
      admin.from("ride_sessions").select("driver_id, partner_id, created_at, status").gte("created_at", since).limit(5000),
    ]);
    if (merchants.error) return NextResponse.json({ error: "Could not load the network" }, { status: 500 });
    const staffRows = staff.error ? [] : (staff.data ?? []);
    const rideRows = rides.error ? [] : (rides.data ?? []);
    const bound = staffRows.filter((s) => !!s.device_id_hash && s.active !== false);
    return NextResponse.json(
      {
        merchants: (merchants.data ?? []).length,
        shop_qr_stands: (merchants.data ?? []).filter((m) => m.static_qr_enabled !== false).length,
        app_devices: bound.length,
        app_devices_by_role: { WAITER: bound.filter((s) => s.role === "WAITER").length, CASHIER: bound.filter((s) => s.role === "CASHIER").length, MANAGER: bound.filter((s) => s.role === "MANAGER").length },
        ride_partners: partners.error ? null : (partners.data ?? []).filter((p) => p.active).length,
        ride_drivers_24h: new Set(rideRows.map((r) => `${r.partner_id}:${r.driver_id}`)).size,
        ride_checkouts_24h: rideRows.length,
        ride_available: !partners.error && !rides.error,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
