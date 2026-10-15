import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/guard";

export const dynamic = "force-dynamic";

const DAY = 86_400_000;
const PAID = ["SUCCESS", "SETTLED"];
/** Audit actions that show who changed where money goes, who proved their identity, and who may connect to 2Pay. */
const CONTROL_ACTIONS = new Set([
  "settlement.update", "settlement.stepup", "settlement.blocked", "vault.enroll", "vault.key.wrong", "vault.locked", "vault.key_reset", "vault.unlock",
  "kyc.submit", "kyc.verified", "kyc.rejected", "kyc.fayda.initiate", "kyc.fayda.verified", "refund.request", "refund.approved", "refund.refunded",
  "ride.partner.create", "ride.partner.rotate", "ride.partner.enable", "ride.partner.disable", "ride.session.create", "ride.session.cancel", "auth.login",
]);

export type PathKind = "PROVIDER_CONFIRMED" | "SIMULATED" | "AWAITING_CALLBACK";

/**
 * The evidence behind the claim "2Pay never holds your money", for the NBE compliance tab. Everything here is read from records the
 * system really keeps: how each paid sale was routed, whether the payment provider's signed callback confirmed it, what is still in
 * flight at a provider, and which phones were bound to the 2Pay app. It is evidence to put in front of an auditor, not a
 * certificate: the proof of zero float is the partner bank's and provider's own statements.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  try {
    const admin = getAdminClient();
    const since = new Date(Date.now() - 7 * DAY).toISOString();
    const [paid, flight, mism, staff, audit] = await Promise.all([
      admin
        .from("transactions")
        .select("id, merchant_id, created_at, processing_at, settled_at, amount, settled_amount, rail, rail_provider, settlement_method, routed_bank, routed_wallet, source, status, base_fee, vat_fee, net_merchant_settlement, payer_app")
        .in("status", PAID)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(200),
      admin.from("transactions").select("id, amount, processing_at").eq("status", "PROCESSING").limit(2000),
      admin.from("watchdog_events").select("id, risk_score", { count: "exact", head: true }).eq("event_type", "SETTLEMENT_MISMATCH").gte("created_at", since),
      admin.from("merchant_staff").select("id, merchant_id, name, role, team_no, active, activated_at, device_id_hash").limit(2000),
      admin.from("audit_log").select("*").order("created_at", { ascending: false }).limit(400),
    ]);
    if (paid.error) return NextResponse.json({ error: "Could not load the settlement evidence" }, { status: 500 });

    const ids = (paid.data ?? []).map((t) => t.id as string);
    const events = ids.length ? await admin.from("rail_events").select("transaction_id, provider, signature_ok, applied, received_at").in("transaction_id", ids) : { data: [], error: null };
    const confirmed = new Map<string, { provider: string; received_at: string }>();
    for (const e of events.error ? [] : (events.data ?? [])) if (e.signature_ok && e.applied && e.transaction_id) confirmed.set(e.transaction_id as string, { provider: e.provider as string, received_at: e.received_at as string });

    const { data: ms } = await admin.from("merchants").select("id, business_name, terminal_id").limit(5000);
    const name = new Map((ms ?? []).map((m) => [m.id as string, m]));

    const sales = (paid.data ?? []).map((t) => {
      const ev = confirmed.get(t.id as string);
      const path: PathKind = ev ? "PROVIDER_CONFIRMED" : t.rail_provider ? "AWAITING_CALLBACK" : "SIMULATED";
      const to = t.settlement_method === "BANK" ? t.routed_bank : t.settlement_method === "WALLET" ? t.routed_wallet : (t.routed_wallet ?? t.routed_bank);
      const m = name.get(t.merchant_id as string);
      return {
        id: t.id,
        time: t.created_at,
        business: m?.business_name ?? "",
        terminal: m?.terminal_id ?? "",
        source: t.source ?? "TERMINAL",
        amount: Number(t.amount),
        payer_app: t.payer_app ?? null,
        provider: t.rail_provider ?? null,
        to_institution: (to as { institution?: string } | null)?.institution ?? t.rail ?? null,
        // masked on the sale when it was made; the full number never reaches this screen
        to_account: (to as { account_masked?: string } | null)?.account_masked ?? null,
        path,
        confirmed_at: ev ? (ev.received_at ?? (t.settled_at as string | null) ?? null) : null,
        seconds_to_settle: t.settled_at && t.processing_at ? Math.max(0, Math.round((new Date(t.settled_at as string).getTime() - new Date(t.processing_at as string).getTime()) / 1000)) : null,
        amount_matches: t.settled_amount == null ? null : Number(t.settled_amount) === Number(t.amount),
        base_fee: t.base_fee == null ? null : Number(t.base_fee),
        vat_fee: t.vat_fee == null ? null : Number(t.vat_fee),
        net_to_merchant: t.net_merchant_settlement == null ? null : Number(t.net_merchant_settlement),
      };
    });
    const count = (k: PathKind) => sales.filter((s) => s.path === k).length;

    const inFlight = flight.error ? [] : (flight.data ?? []);
    const oldest = inFlight.map((t) => (t.processing_at ? new Date(t.processing_at as string).getTime() : Date.now())).sort((a, b) => a - b)[0];

    const devices = (staff.error ? [] : (staff.data ?? []))
      .filter((s) => !!s.device_id_hash)
      .map((s) => ({
        name: s.name,
        role: s.role,
        team_no: s.team_no,
        business: name.get(s.merchant_id as string)?.business_name ?? "",
        active: s.active !== false,
        activated_at: s.activated_at ?? null,
        // a short fingerprint: enough to tell two phones apart, never the stored hash itself
        device: String(s.device_id_hash).slice(0, 10),
      }));

    const controls = (audit.error ? [] : (audit.data ?? []))
      .filter((a) => CONTROL_ACTIONS.has(a.action as string))
      .slice(0, 100)
      .map((a) => ({ time: a.created_at, action: a.action, actor: a.actor_phone ?? null, role: a.role ?? null, target: `${a.target_type ?? ""} ${String(a.target_id ?? "").slice(0, 8)}`.trim(), ip: a.ip ?? null }));

    return NextResponse.json(
      {
        window_days: 7,
        paths: { total: sales.length, provider_confirmed: count("PROVIDER_CONFIRMED"), simulated: count("SIMULATED"), awaiting_callback: count("AWAITING_CALLBACK") },
        in_flight: { count: inFlight.length, amount: inFlight.reduce((s, t) => s + Number(t.amount), 0), oldest_minutes: oldest ? Math.round((Date.now() - oldest) / 60_000) : null },
        settlement_mismatches_7d: mism.error ? null : (mism.count ?? 0),
        sales,
        devices,
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
