import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { clientIp } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const TERMINAL_ID = /^TRM-\d{4}$/;

/** Public facts about a shop for its scan-to-pay page: its name, and whether it can take payments right now. */
export async function GET(req: Request, { params }: { params: Promise<{ terminal: string }> }) {
  const { terminal } = await params;
  const id = terminal.toUpperCase();
  if (!TERMINAL_ID.test(id)) return NextResponse.json({ error: "Unknown shop" }, { status: 404 });
  try {
    const admin = getAdminClient();
    if (!(await rateLimit(admin, `terminal-info:${clientIp(req)}`, 60, 60))) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    const { data, error } = await admin.from("merchants").select("business_name, category, location, active_bank, active_wallet, static_qr_enabled").eq("terminal_id", id).maybeSingle();
    if (error) return NextResponse.json({ error: "Could not load this shop" }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Unknown shop" }, { status: 404 });
    return NextResponse.json({
      terminal_id: id,
      business_name: data.business_name,
      category: data.category,
      location: data.location,
      accepting: data.static_qr_enabled !== false && !!(data.active_bank || data.active_wallet),
    });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
