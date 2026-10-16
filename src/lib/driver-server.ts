import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase-admin";
import { requireSession } from "@/lib/guard";
import type { SessionPayload } from "@/lib/session";

/** Guard for the endpoints a signed-in DRIVER uses (their links to ride-hailing companies, the rides waiting for them). */
export type DriverGuard = { ok: true; merchantId: string; phone: string; session: SessionPayload } | { ok: false; res: NextResponse };

const deny = (status: number, error: string): DriverGuard => ({ ok: false, res: NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } }) });

export async function requireDriver(): Promise<DriverGuard> {
  const g = await requireSession();
  if (!g.ok) return g;
  const s = g.session;
  if (!s) return deny(401, "Sign in to your 2Pay account first.");
  if ((s.rl ?? "OWNER") !== "OWNER") return deny(403, "Only the driver can do this.");
  const { data } = await getAdminClient().from("merchants").select("id, kind").eq("id", s.mid).maybeSingle();
  if (!data || data.kind !== "DRIVER") return deny(403, "This is for ride-service drivers. Register with the Ride Service category.");
  return { ok: true, merchantId: data.id as string, phone: s.ph, session: s };
}
