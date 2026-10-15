"use client";

import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Landmark, Loader2, ShieldCheck, Smartphone } from "lucide-react";
import { fmt, formatEAT } from "@/lib/format";
import { cn } from "@/lib/utils";

type Path = "PROVIDER_CONFIRMED" | "SIMULATED" | "AWAITING_CALLBACK";
interface Sale {
  id: string;
  time: string;
  business: string;
  terminal: string;
  source: string;
  amount: number;
  payer_app: string | null;
  provider: string | null;
  to_institution: string | null;
  to_account: string | null;
  path: Path;
  confirmed_at: string | null;
  seconds_to_settle: number | null;
  amount_matches: boolean | null;
  base_fee: number | null;
  vat_fee: number | null;
  net_to_merchant: number | null;
}
interface Data {
  window_days: number;
  paths: { total: number; provider_confirmed: number; simulated: number; awaiting_callback: number };
  in_flight: { count: number; amount: number; oldest_minutes: number | null };
  settlement_mismatches_7d: number | null;
  sales: Sale[];
  devices: { name: string; role: string; team_no: string | null; business: string; active: boolean; activated_at: string | null; device: string }[];
  controls: { time: string; action: string; actor: string | null; role: string | null; target: string; ip: string | null }[];
  design: string[];
  not_built: string[];
}

const PATH: Record<Path, { label: string; cls: string }> = {
  PROVIDER_CONFIRMED: { label: "Provider-confirmed", cls: "bg-emerald-500/15 text-emerald-300" },
  AWAITING_CALLBACK: { label: "Awaiting provider callback", cls: "bg-amber-500/15 text-amber-300" },
  SIMULATED: { label: "Simulated (no money moved)", cls: "bg-slate-800 text-slate-300" },
};

type Section = "paths" | "devices" | "controls";

/**
 * Evidence for the central bank: the route every paid sale took, whether the payment provider's signed callback confirmed it, what is
 * still in flight at a provider, which phones are bound to the app, and the log of sensitive changes. It is evidence, not a
 * certificate: the proof of zero float is the partner bank's and provider's own statements.
 */
export function ComplianceAudit() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Section>("paths");
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/compliance", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not load");
      setD(j);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!d && !err) return <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-500" />;
  if (!d) return <p className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{err}</p>;
  const pc = d.paths.total ? Math.round((d.paths.provider_confirmed / d.paths.total) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile icon={Landmark} label={`Paid sales, last ${d.window_days} days`} value={String(d.paths.total)} sub={`${d.paths.provider_confirmed} provider-confirmed (${pc}%) · ${d.paths.simulated} simulated`} />
        <Tile icon={ShieldCheck} label="Funds in flight at providers" value={`${fmt(d.in_flight.amount)} ETB`} sub={`${d.in_flight.count} payment${d.in_flight.count === 1 ? "" : "s"}${d.in_flight.oldest_minutes != null ? ` · oldest ${d.in_flight.oldest_minutes} min` : ""}`} warn={d.in_flight.oldest_minutes != null && d.in_flight.oldest_minutes > 60} />
        <Tile icon={CircleAlert} label="Settlement mismatches" value={d.settlement_mismatches_7d == null ? "—" : String(d.settlement_mismatches_7d)} sub="provider amount differed from the quote" warn={!!d.settlement_mismatches_7d} />
        <Tile icon={Smartphone} label="Phones bound to the app" value={String(d.devices.length)} sub="by the app's own install id" />
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-950 p-3 text-sm">
        <div className="mb-1 font-semibold">How the system is built</div>
        <ul className="list-disc space-y-1 pl-5 text-slate-300">{d.design.map((x) => <li key={x}>{x}</li>)}</ul>
        <div className="mt-3 font-semibold text-amber-300">Not built yet</div>
        <ul className="list-disc space-y-1 pl-5 text-amber-200/90">{d.not_built.map((x) => <li key={x}>{x}</li>)}</ul>
      </div>

      <div className="flex gap-1 text-sm">
        {([["paths", "Settlement paths"], ["devices", "Device metadata"], ["controls", "Control events"]] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={cn("rounded-lg px-3 py-1.5 font-medium", tab === id ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200")}>{label}</button>
        ))}
      </div>

      {tab === "paths" && (
        <Table
          cols={["Time (EAT)", "Business", "Channel", "Amount", "Payer app → provider → receiving account", "Evidence", "Settle time", "Fee + VAT / merchant net"]}
          empty="No paid sales in this window."
          rows={d.sales.map((s) => [
            formatEAT(s.time),
            `${s.business} (${s.terminal})`,
            s.source,
            `${fmt(s.amount)} ETB${s.amount_matches === false ? " ⚠ differs" : ""}`,
            `${s.payer_app ?? "—"} → ${s.provider ?? "—"} → ${s.to_institution ?? "—"} ${s.to_account ?? ""}`,
            <span key="p" className={cn("rounded-full px-2 py-0.5 text-xs font-medium", PATH[s.path].cls)}>{PATH[s.path].label}{s.confirmed_at ? ` · ${formatEAT(s.confirmed_at)}` : ""}</span>,
            s.seconds_to_settle == null ? "—" : `${s.seconds_to_settle}s`,
            s.base_fee == null ? "(before V2.5)" : `${(s.base_fee + (s.vat_fee ?? 0)).toFixed(4)} / ${s.net_to_merchant?.toFixed(2)}`,
          ])}
        />
      )}
      {tab === "devices" && (
        <Table
          cols={["Person", "Role", "Business", "Bound (EAT)", "Device fingerprint", "Status"]}
          empty="No phones are bound yet."
          rows={d.devices.map((x) => [`${x.name}${x.team_no ? ` (${x.team_no})` : ""}`, x.role, x.business, x.activated_at ? formatEAT(x.activated_at) : "—", <code key="c" className="text-xs">{x.device}…</code>, x.active ? "Active" : "Removed"])}
        />
      )}
      {tab === "controls" && (
        <Table
          cols={["Time (EAT)", "Action", "By", "Role", "Target", "From"]}
          empty="No control events yet."
          rows={d.controls.map((c) => [formatEAT(c.time), <code key="a" className="text-xs">{c.action}</code>, c.actor ?? "—", c.role ?? "—", c.target, c.ip ?? "—"])}
        />
      )}
    </div>
  );
}

function Tile({ icon: Icon, label, value, sub, warn }: { icon: typeof Landmark; label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
      <div className="flex items-center justify-between text-xs text-slate-400">{label} <Icon className="h-4 w-4 text-brand" /></div>
      <div className={cn("mt-2 text-xl font-bold tabular-nums", warn && "text-amber-400")}>{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

function Table({ cols, rows, empty }: { cols: string[]; rows: React.ReactNode[][]; empty: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-left text-sm">
        <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
          <tr>{cols.map((c) => <th key={c} className="px-3 py-2 font-medium">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={cols.length} className="px-3 py-8 text-center text-slate-500">{empty}</td></tr>}
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-slate-800/60 align-top last:border-0">
              {r.map((c, j) => <td key={j} className="max-w-xs break-words px-3 py-2 text-slate-300">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
