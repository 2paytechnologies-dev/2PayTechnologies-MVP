import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/guard";
import { EKYC_MAX_ATTEMPTS, ekycMode, faydaRequired } from "@/lib/fayda-ekyc";
import { faydaConfigured } from "@/lib/fayda";

export const dynamic = "force-dynamic";

export type FaydaState = "VERIFIED" | "IN_PROGRESS" | "LOCKED" | "NOT_STARTED";

/**
 * The Fayda (national ID) verification status of every business owner: verified, a code request in progress, a request used up by
 * wrong codes, or not started. Never the FAN, the name or any ID detail: admins see only who is verified, when, and the gateway
 * transaction id they could quote to the National ID Program.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  try {
    const admin = getAdminClient();
    const [m, s] = await Promise.all([
      admin.from("merchants").select("id, business_name, terminal_id, phone, kyc_status, fayda_verified, fayda_verified_at, fayda_verification_timestamp, fayda_transaction_id").order("business_name").limit(2000),
      admin.from("fayda_sessions").select("merchant_id, attempts, expires_at, consumed_at, created_at").order("created_at", { ascending: false }).limit(5000),
    ]);
    if (m.error) return NextResponse.json({ error: "Could not load the Fayda status. Has supabase/v2_5.sql been run?" }, { status: 500 });
    const latest = new Map<string, { attempts: number; expires_at: string; consumed_at: string | null; created_at: string }>();
    for (const r of s.error ? [] : (s.data ?? [])) if (!latest.has(r.merchant_id)) latest.set(r.merchant_id, r);

    const rows = (m.data ?? []).map((r) => {
      const verified = !!(r.fayda_verified || r.fayda_verified_at);
      const q = latest.get(r.id);
      const open = q && !q.consumed_at && new Date(q.expires_at).getTime() > Date.now();
      const state: FaydaState = verified ? "VERIFIED" : open && q.attempts >= EKYC_MAX_ATTEMPTS ? "LOCKED" : open ? "IN_PROGRESS" : "NOT_STARTED";
      return {
        id: r.id,
        business: r.business_name,
        terminal: r.terminal_id,
        phone: r.phone,
        kyc_status: r.kyc_status,
        state,
        verified_at: verified ? (r.fayda_verification_timestamp ?? r.fayda_verified_at ?? null) : null,
        gateway_ref: verified ? (r.fayda_transaction_id ?? null) : null,
        last_request: q?.created_at ?? null,
        wrong_codes: open ? q.attempts : 0,
      };
    });
    const count = (st: FaydaState) => rows.filter((r) => r.state === st).length;
    return NextResponse.json(
      {
        summary: { total: rows.length, verified: count("VERIFIED"), in_progress: count("IN_PROGRESS"), locked: count("LOCKED"), not_started: count("NOT_STARTED") },
        // what is switched on right now, so the tracker can say why nobody can verify yet
        setup: { required: faydaRequired(), ekyc: ekycMode() ?? "off", browser_signin: faydaConfigured() },
        rows,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
