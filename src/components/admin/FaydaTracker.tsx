"use client";

import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, ChevronLeft, ChevronRight, Clock, Fingerprint, Loader2, Lock, Search, ShieldQuestion } from "lucide-react";
import { formatEAT } from "@/lib/format";
import { cn } from "@/lib/utils";

type State = "VERIFIED" | "IN_PROGRESS" | "LOCKED" | "NOT_STARTED";
type Filter = "ALL" | "VERIFIED" | "PENDING" | "IN_PROGRESS" | "LOCKED";
interface Row {
  id: string;
  business: string;
  terminal: string;
  phone: string | null;
  kyc_status: string;
  state: State;
  verified_at: string | null;
  gateway_ref: string | null;
  wrong_codes: number;
}
interface Data {
  summary: { total: number; verified: number; in_progress: number; locked: number; not_started: number };
  setup: { required: boolean; ekyc: "sandbox" | "gateway" | "off"; browser_signin: boolean };
  rows: Row[];
  paging: { page: number; pages: number; matching: number };
}

const META: Record<State, { label: string; cls: string; icon: typeof BadgeCheck }> = {
  VERIFIED: { label: "Verified", cls: "bg-emerald-500/15 text-emerald-300", icon: BadgeCheck },
  IN_PROGRESS: { label: "Code sent", cls: "bg-sky-500/15 text-sky-300", icon: Clock },
  LOCKED: { label: "Locked (wrong codes)", cls: "bg-amber-500/15 text-amber-300", icon: Lock },
  NOT_STARTED: { label: "Not started", cls: "bg-slate-800 text-slate-300", icon: ShieldQuestion },
};

/**
 * Fayda (national ID) verification of business owners, for any number of merchants: counts added up by the database, one page of 25
 * at a time, and a search to find one merchant. It never shows a FAN, a name or any ID detail.
 */
export function FaydaTracker() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/fayda?${new URLSearchParams({ state: filter, page: String(page), q: applied })}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not load");
      setD(j);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [filter, page, applied]);
  useEffect(() => {
    void load();
    const id = setInterval(load, 20_000);
    return () => clearInterval(id);
  }, [load]);

  if (!d && !err) return <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-500" />;
  if (!d) return <p className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{err}</p>;
  const { summary } = d;
  const pct = summary.total ? Math.round((summary.verified / summary.total) * 100) : 0;
  const chip = (id: Filter, label: string, n: number) => (
    <button key={id} onClick={() => { setFilter(id); setPage(1); }} className={cn("rounded-full px-3 py-1 font-medium", filter === id ? "bg-slate-700 text-white" : "bg-slate-950 text-slate-400 hover:text-slate-200")}>
      {label} · {n.toLocaleString()}
    </button>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={cn("rounded px-2 py-1", d.setup.required ? "bg-amber-500/15 text-amber-300" : "bg-slate-800 text-slate-300")}>
          {d.setup.required ? "Mandatory: live payments need a verified owner" : "Not mandatory right now (simulated mode, or switched off)"}
        </span>
        <span className={cn("rounded px-2 py-1", d.setup.ekyc === "off" ? "bg-rose-500/15 text-rose-300" : "bg-emerald-500/15 text-emerald-300")}>
          FAN + code: {d.setup.ekyc === "off" ? "gateway not connected" : d.setup.ekyc}
        </span>
        <span className="rounded bg-slate-800 px-2 py-1 text-slate-300">Browser sign-in: {d.setup.browser_signin ? "on" : "off"}</span>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="flex items-center gap-2 font-semibold"><Fingerprint className="h-4 w-4 text-brand" /> {summary.verified.toLocaleString()} of {summary.total.toLocaleString()} owners verified</span>
          <span className="tabular-nums text-slate-400">{pct}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded bg-slate-800"><div className="h-full bg-brand" style={{ width: `${pct}%` }} /></div>
      </div>

      <div className="flex flex-wrap gap-1 text-xs">
        {chip("ALL", "All", summary.total)}
        {chip("VERIFIED", "Verified", summary.verified)}
        {chip("PENDING", "Not verified", summary.total - summary.verified)}
        {chip("IN_PROGRESS", "Code sent", summary.in_progress)}
        {chip("LOCKED", "Locked", summary.locked)}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); setPage(1); setApplied(q.trim()); }} className="flex gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a merchant: terminal id (TRM-0002), phone, or part of the name" className="h-10 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm" />
        <button className="inline-flex h-10 items-center gap-2 rounded-lg bg-slate-700 px-4 text-sm font-semibold text-white"><Search className="h-4 w-4" /> Search</button>
        {applied && <button type="button" onClick={() => { setQ(""); setApplied(""); setPage(1); }} className="h-10 rounded-lg border border-slate-700 px-3 text-sm text-slate-300">Clear</button>}
      </form>

      <div className={cn("overflow-x-auto", busy && "opacity-70")}>
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
            <tr>{["Business", "Owner phone", "Business KYC", "National ID (Fayda)", "Verified (EAT)", "Gateway reference"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {d.rows.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-500">No one matches.</td></tr>}
            {d.rows.map((r) => {
              const M = META[r.state];
              return (
                <tr key={r.id} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-3 py-2"><div className="font-medium">{r.business}</div><div className="text-xs text-slate-500">{r.terminal}</div></td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-300">{r.phone ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-300">{r.kyc_status}</td>
                  <td className="px-3 py-2">
                    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium", M.cls)}><M.icon className="h-3.5 w-3.5" /> {M.label}</span>
                    {r.state === "IN_PROGRESS" && r.wrong_codes > 0 && <div className="mt-1 text-xs text-amber-300">{r.wrong_codes} wrong code{r.wrong_codes === 1 ? "" : "s"}</div>}
                  </td>
                  <td className="px-3 py-2 text-slate-300">{r.verified_at ? formatEAT(r.verified_at) : "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-400">{r.gateway_ref ? r.gateway_ref.slice(0, 13) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>{d.paging.matching.toLocaleString()} match · page {d.paging.page} of {d.paging.pages}</span>
        <span className="flex gap-2">
          <button disabled={page <= 1 || busy} onClick={() => setPage((p) => p - 1)} className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-1.5 disabled:opacity-40"><ChevronLeft className="h-3.5 w-3.5" /> Previous</button>
          <button disabled={page >= d.paging.pages || busy} onClick={() => setPage((p) => p + 1)} className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-1.5 disabled:opacity-40">Next <ChevronRight className="h-3.5 w-3.5" /></button>
        </span>
      </div>
      <p className="text-xs text-slate-500">This view never shows a Fayda number, a name or any ID detail; the FAN is kept encrypted on the business record.</p>
    </div>
  );
}
