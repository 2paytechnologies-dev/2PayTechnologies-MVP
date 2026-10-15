"use client";

import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Download, Landmark, Loader2, Search, ShieldCheck, Smartphone } from "lucide-react";
import { fmt, formatEAT } from "@/lib/format";
import type { PathKind, SaleEvidence } from "@/lib/compliance-sales";
import { cn } from "@/lib/utils";

interface Exception {
  id: string;
  time: string;
  business: string;
  terminal: string;
  amount: number;
  settled_amount: number | null;
  provider: string | null;
  reason: "STUCK_IN_FLIGHT" | "AMOUNT_DIFFERS" | "NO_PROVIDER_CONFIRMATION";
}
interface Data {
  window_days: number;
  paths: { total: number; provider_confirmed: number; simulated: number; awaiting_callback: number };
  in_flight: { count: number; amount: number; oldest_minutes: number | null };
  settlement_mismatches_7d: number;
  exceptions: Exception[];
  sample: SaleEvidence[];
  devices: { total: number; latest: { name: string; role: string; team_no: string | null; business: string; active: boolean; activated_at: string | null; device: string }[] };
  controls: { time: string; action: string; actor: string | null; role: string | null; target: string; ip: string | null }[];
  design: string[];
  not_built: string[];
}

const PATH: Record<PathKind, { label: string; cls: string }> = {
  PROVIDER_CONFIRMED: { label: "Provider-confirmed", cls: "bg-emerald-500/15 text-emerald-300" },
  AWAITING_CALLBACK: { label: "Awaiting provider callback", cls: "bg-amber-500/15 text-amber-300" },
  SIMULATED: { label: "Simulated (no money moved)", cls: "bg-slate-800 text-slate-300" },
};
const REASON: Record<Exception["reason"], string> = {
  STUCK_IN_FLIGHT: "In flight at the provider for over an hour",
  AMOUNT_DIFFERS: "The provider's amount differs from the quote",
  NO_PROVIDER_CONFIRMATION: "Paid, but the provider's callback never confirmed it",
};

type Section = "exceptions" | "sales" | "devices" | "controls";
const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Evidence for the central bank, built to stay readable at any volume: summary numbers added up in the database, the EXCEPTIONS that need
 * a human, a search to find any one sale, and a file export for an auditor, instead of a list of every sale. It is evidence, not a
 * certificate: the proof of zero float is the partner bank's and provider's own statements.
 */
export function ComplianceAudit() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Section>("exceptions");
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
        <Tile icon={Landmark} label={`Paid sales, last ${d.window_days} days`} value={d.paths.total.toLocaleString()} sub={`${d.paths.provider_confirmed.toLocaleString()} provider-confirmed (${pc}%) · ${d.paths.simulated.toLocaleString()} simulated`} />
        <Tile icon={ShieldCheck} label="Funds in flight at providers" value={`${fmt(d.in_flight.amount)} ETB`} sub={`${d.in_flight.count} payment${d.in_flight.count === 1 ? "" : "s"}${d.in_flight.oldest_minutes != null ? ` · oldest ${d.in_flight.oldest_minutes} min` : ""}`} warn={d.in_flight.oldest_minutes != null && d.in_flight.oldest_minutes > 60} />
        <Tile icon={CircleAlert} label="Needs a human" value={String(d.exceptions.length)} sub={`${d.settlement_mismatches_7d} settlement mismatch${d.settlement_mismatches_7d === 1 ? "" : "es"} flagged by the Watchdog`} warn={d.exceptions.length > 0} />
        <Tile icon={Smartphone} label="Phones bound to the app" value={d.devices.total.toLocaleString()} sub="by the app's own install id" />
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-950 p-3 text-sm">
        <div className="mb-1 font-semibold">How the system is built</div>
        <ul className="list-disc space-y-1 pl-5 text-slate-300">{d.design.map((x) => <li key={x}>{x}</li>)}</ul>
        <div className="mt-3 font-semibold text-amber-300">Not built yet</div>
        <ul className="list-disc space-y-1 pl-5 text-amber-200/90">{d.not_built.map((x) => <li key={x}>{x}</li>)}</ul>
      </div>

      <ExportBox />

      <div className="flex flex-wrap gap-1 text-sm">
        {([["exceptions", `Exceptions · ${d.exceptions.length}`], ["sales", "Find a sale"], ["devices", "Device metadata"], ["controls", "Control events"]] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={cn("rounded-lg px-3 py-1.5 font-medium", tab === id ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200")}>{label}</button>
        ))}
      </div>

      {tab === "exceptions" && (
        <Table
          cols={["Time (EAT)", "Business", "Amount", "Provider", "Why it needs a look", "Sale"]}
          empty="Nothing needs attention. Every paid sale in this window is confirmed, matches its quote, and nothing is stuck."
          rows={d.exceptions.map((e) => [formatEAT(e.time), `${e.business} (${e.terminal})`, `${fmt(e.amount)} ETB${e.settled_amount != null ? ` (provider: ${fmt(e.settled_amount)})` : ""}`, e.provider ?? "—", REASON[e.reason], <code key="i" className="text-xs">{String(e.id).slice(0, 8)}</code>])}
        />
      )}
      {tab === "sales" && <SalesFinder initial={d.sample} />}
      {tab === "devices" && (
        <Table
          cols={["Person", "Role", "Business", "Bound (EAT)", "Device fingerprint", "Status"]}
          empty="No phones are bound yet."
          rows={d.devices.latest.map((x) => [`${x.name}${x.team_no ? ` (${x.team_no})` : ""}`, x.role, x.business, x.activated_at ? formatEAT(x.activated_at) : "—", <code key="c" className="text-xs">{x.device}…</code>, x.active ? "Active" : "Removed"])}
          foot={d.devices.total > d.devices.latest.length ? `Showing the ${d.devices.latest.length} most recent of ${d.devices.total.toLocaleString()}.` : undefined}
        />
      )}
      {tab === "controls" && (
        <Table
          cols={["Time (EAT)", "Action", "By", "Role", "Target", "From"]}
          empty="No control events yet."
          rows={d.controls.map((c) => [formatEAT(c.time), <code key="a" className="text-xs">{c.action}</code>, c.actor ?? "—", c.role ?? "—", c.target, c.ip ?? "—"])}
          foot="The latest 50 sensitive changes. The full audit log is under the Audit log tab."
        />
      )}
    </div>
  );
}

/** Find any one sale (or a business's sales) by id, terminal or name, inside a date range. */
function SalesFinder({ initial }: { initial: SaleEvidence[] }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<SaleEvidence[]>(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(initial.length ? "The latest sales. Type to search all of them." : null);
  const search = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/sales?${new URLSearchParams({ q, limit: "25", from: new Date(Date.now() - 92 * 86_400_000).toISOString() })}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not search");
      setRows(j.sales);
      setNote(j.sales.length ? `${j.sales.length === 25 ? "The first 25 matches (newest first)." : `${j.sales.length} match${j.sales.length === 1 ? "" : "es"}.`}` : "Nothing matches.");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <form onSubmit={(e) => { e.preventDefault(); void search(); }} className="flex gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Transaction id (start of it), terminal id, or business name" className="h-10 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm" />
        <button disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-lg bg-slate-700 px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Search</button>
      </form>
      {note && <p className="text-xs text-slate-500">{note}</p>}
      <Table
        cols={["Time (EAT)", "Business", "Channel", "Amount", "Payer app → provider → receiving account", "Evidence", "Settle time", "Fee + VAT / merchant net"]}
        empty="No sales."
        rows={rows.map((s) => [
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
    </div>
  );
}

/** Download the evidence for a date range as a file (read in pages and streamed by the server). */
function ExportBox() {
  const [from, setFrom] = useState(() => day(new Date(Date.now() - 30 * 86_400_000)));
  const [to, setTo] = useState(() => day(new Date()));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/admin/compliance/export?${new URLSearchParams({ from, to })}`);
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Could not export");
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `2pay-sales-evidence-${from}_${to}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-800 bg-slate-950 p-3 text-sm">
      <div>
        <div className="mb-1 font-semibold">Export the evidence for an auditor</div>
        <div className="text-xs text-slate-500">Every paid sale in the range, as a CSV file (up to 92 days and 100,000 rows at a time).</div>
      </div>
      <label className="text-xs text-slate-400">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="ml-2 h-9 rounded-lg border border-slate-700 bg-slate-900 px-2 text-sm text-slate-100" /></label>
      <label className="text-xs text-slate-400">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="ml-2 h-9 rounded-lg border border-slate-700 bg-slate-900 px-2 text-sm text-slate-100" /></label>
      <button disabled={busy} onClick={go} className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-4 font-semibold text-slate-950 disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Export CSV</button>
      {msg && <span className="text-xs text-rose-300">{msg}</span>}
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

function Table({ cols, rows, empty, foot }: { cols: string[]; rows: React.ReactNode[][]; empty: string; foot?: string }) {
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
      {foot && <p className="mt-2 text-xs text-slate-500">{foot}</p>}
    </div>
  );
}
