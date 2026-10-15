import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/guard";
import { shapeSale } from "@/lib/compliance-sales";

export const dynamic = "force-dynamic";

const DAY = 86_400_000;
/** Audit actions that show who changed where money goes, who proved their identity, and who may connect to 2Pay. */
const CONTROL_ACTIONS = new Set([
  "settlement.update", "settlement.stepup", "settlement.blocked", "vault.enroll", "vault.key.wrong", "vault.locked", "vault.key_reset", "vault.key_reset.self", "vault.unlock",
  "kyc.submit", "kyc.verified", "kyc.rejected", "kyc.fayda.initiate", "kyc.fayda.verified", "refund.request", "refund.approved", "refund.refunded",
  "ride.partner.create", "ride.partner.rotate", "ride.partner.enable", "ride.partner.disable", "ride.session.create", "ride.session.cancel", "auth.login",
]);

/**
 * The evidence behind the claim "2Pay never holds your money", for the NBE compliance tab. It is built to stay readable at any volume:
 *  - SUMMARY numbers computed in the database (paid sales by kind of evidence, funds in flight, mismatches);
 *  - EXCEPTIONS only: the sales that need a human (no provider confirmation, a differing amount, a payment stuck in flight);
 *  - a short sample of the latest sales (search and export are separate: /api/admin/sales and /api/admin/compliance/export).
 * It is evidence for an auditor, not a certificate: the proof of zero float is the partner bank's and provider's own statements.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  try {
    const admin = getAdminClient();
    const from = new Date(Date.now() - 7 * DAY).toISOString();
    const [summary, exceptions, sample, staff, audit, counts] = await Promise.all([
      admin.rpc("admin_compliance_summary", { p_from: from }),
      admin.rpc("admin_compliance_exceptions", { p_from: from, p_limit: 50 }),
      admin.rpc("admin_find_sales", { p_q: "", p_from: from, p_to: new Date(Date.now() + DAY).toISOString(), p_limit: 10 }),
      admin.from("merchant_staff").select("id, merchant_id, name, role, team_no, active, activated_at, device_id_hash").order("activated_at", { ascending: false }).limit(300),
      admin.from("audit_log").select("*").order("created_at", { ascending: false }).limit(300),
      admin.rpc("admin_network_counts"),
    ]);
    if (summary.error) {
      console.error("[admin/compliance]", summary.error.message);
      return NextResponse.json({ error: "Could not load the settlement evidence. Has supabase/v2_6.sql been run?" }, { status: 500 });
    }
    const s = summary.data as { total: number; provider_confirmed: number; simulated: number; awaiting_callback: number; in_flight: { count: number; amount: number; oldest: string | null }; mismatches: number };

    const bound = (staff.error ? [] : (staff.data ?? [])).filter((x) => !!x.device_id_hash);
    const names = new Map<string, string>();
    const mids = [...new Set(bound.slice(0, 25).map((x) => x.merchant_id as string))];
    if (mids.length) {
      const { data } = await admin.from("merchants").select("id, business_name").in("id", mids);
      for (const m of data ?? []) names.set(m.id as string, m.business_name as string);
    }
    const devices = bound.slice(0, 25).map((x) => ({
      name: x.name,
      role: x.role,
      team_no: x.team_no,
      business: names.get(x.merchant_id as string) ?? "",
      active: x.active !== false,
      activated_at: x.activated_at ?? null,
      // a short fingerprint: enough to tell two phones apart, never the stored hash itself
      device: String(x.device_id_hash).slice(0, 10),
    }));

    const controls = (audit.error ? [] : (audit.data ?? []))
      .filter((a) => CONTROL_ACTIONS.has(a.action as string))
      .slice(0, 50)
      .map((a) => ({ time: a.created_at, action: a.action, actor: a.actor_phone ?? null, role: a.role ?? null, target: `${a.target_type ?? ""} ${String(a.target_id ?? "").slice(0, 8)}`.trim(), ip: a.ip ?? null }));

    return NextResponse.json(
      {
        window_days: 7,
        paths: { total: s.total, provider_confirmed: s.provider_confirmed, simulated: s.simulated, awaiting_callback: s.awaiting_callback },
        in_flight: { count: s.in_flight.count, amount: Number(s.in_flight.amount), oldest_minutes: s.in_flight.oldest ? Math.max(0, Math.round((Date.now() - new Date(s.in_flight.oldest).getTime()) / 60_000)) : null },
        settlement_mismatches_7d: s.mismatches,
        exceptions: ((exceptions.data ?? []) as Record<string, unknown>[]).map((e) => ({ id: e.id, time: e.created_at, business: e.business, terminal: e.terminal, amount: Number(e.amount), settled_amount: e.settled_amount == null ? null : Number(e.settled_amount), provider: e.provider ?? null, reason: e.reason })),
        sample: ((sample.data ?? []) as Record<string, unknown>[]).map(shapeSale),
        devices: { total: (counts.data as { app_devices?: number } | null)?.app_devices ?? bound.length, latest: devices },
        controls,
        // facts about how the system is built, each checkable in the code; they are design statements, not audited results
        design: [
          "2Pay has no wallet, balance or pooled-funds table: the database holds sales, not money.",
          "A live payment is created at the payment provider with the merchant's own bank or wallet as the beneficiary.",
          "A sale becomes paid only when the provider's signed callback arrives (never from the customer's phone or the terminal).",
          "Receiving accounts can be changed only with the owner's or manager's security key and a code sent to their own phone, and every change is logged.",
        ],
        not_built: [
          "Device attestation (Play Integrity / hardware-backed): the phones listed are bound by the app's own install id, not attested by Google.",
          "Provider or bank statement reconciliation: the proof of zero float is the partner's statement, which 2Pay does not import.",
        ],
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
