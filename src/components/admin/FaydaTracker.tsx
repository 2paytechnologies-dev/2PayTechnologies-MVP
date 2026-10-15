"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgeCheck, Clock, Fingerprint, Loader2, Lock, ShieldQuestion } from "lucide-react";
import { formatEAT } from "@/lib/format";
import { cn } from "@/lib/utils";

type State = "VERIFIED" | "IN_PROGRESS" | "LOCKED" | "NOT_STARTED";
interface Row {
  id: string;
  business: string;
  terminal: string;
  phone: string | null;
  kyc_status: string;
  state: State;
  verified_at: string | null;
  gateway_ref: string | null;
  last_request: string | null;
  wrong_codes: number;
}
interface Data {
  summary: { total: number; verified: number; in_progress: number; locked: number; not_started: number };
  setup: { required: boolean; ekyc: "sandbox" | "gateway" | "off"; browser_signin: boolean };
  rows: Row[];
}

const META: Record<State, { label: string; cls: string; icon: typeof BadgeCheck }> = {
  VERIFIED: { label: "Verified", cls: "bg-emerald-500/15 text-emerald-300", icon: BadgeCheck },
  IN_PROGRESS: { label: "Code sent", cls: "bg-sky-500/15 text-sky-300", icon: Clock },
  LOCKED: { label: "Locked (wrong codes)", cls: "bg-amber-500/15 text-amber-300", icon: Lock },
  NOT_STARTED: { label: "Not started", cls: "bg-slate-800 text-slate-300", icon: ShieldQuestion },
};

/**
 * Fayda (national ID) verification of every primary business owner. Shows who is verified and when, who is part-way, and who has not
 * started, so onboarding can be chased. It never shows a FAN, a name or any ID detail.
 */
export function FaydaTracker() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<State | "ALL">("ALL");
  const [q, setQ] = useState("");
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/fayda", { cache: "no-store" });
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
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (d?.rows ?? []).filter((r) => (filter === "ALL" || r.state === filter) && (!n || [r.business, r.terminal, r.phone].some((v) => String(v ?? "").toLowerCase().includes(n))));
  }, [d, filter, q]);

  if (!d && !err) return <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-500" />;
  if (!d) return <p className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{err}</p>;
  const pct = d.summary.total ? Math.round((d.summary.verified / d.summary.total) * 100) : 0;

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
          <span className="flex items-center gap-2 font-semibold"><Fingerprint className="h-4 w-4 text-brand" /> {d.summary.verified} of {d.summary.total} owners verified</span>
          <span className="tabular-nums text-slate-400">{pct}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded bg-slate-800"><div className="h-full bg-brand" style={{ width: `${pct}%` }} /></div>
      </div>

      <div className="flex flex-wrap gap-1 text-xs">
        {(["ALL", "VERIFIED", "IN_PROGRESS", "LOCKED", "NOT_STARTED"] as const).map((s) => (
          <button key={s} onClick={() => setFilter(s)} className={cn("rounded-full px-3 py-1 font-medium", filter === s ? "bg-slate-700 text-white" : "bg-slate-950 text-slate-400 hover:text-slate-200")}>
            {s === "ALL" ? `All · ${d.summary.total}` : `${META[s].label} · ${s === "VERIFIED" ? d.summary.verified : s === "IN_PROGRESS" ? d.summary.in_progress : s === "LOCKED" ? d.summary.locked : d.summary.not_started}`}
          </button>
        ))}
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search business, terminal or phone" className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm" />

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
            <tr>{["Business", "Owner phone", "Business KYC", "National ID (Fayda)", "Verified (EAT)", "Gateway reference"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-500">No one matches.</td></tr>}
            {shown.map((r) => {
              const M = META[r.state];
              return (
                <tr key={r.id} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-3 py-2"><div className="font-medium">{r.business}</div><div className="text-xs text-slate-500">{r.terminal}</div></td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-300">{r.phone ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-300">{r.kyc_status}</td>
                  <td className="px-3 py-2">
                    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium", M.cls)}><M.icon className="h-3.5 w-3.5" /> {M.label}</span>
                    {r.state === "IN_PROGRESS" && r.wrong_codes > 0 && <div className="mt-1 text-xs text-amber-300">{r.wrong_codes} wrong code{r.wrong_codes === 1 ? "" : "s"}</div>}
                    {r.last_request && r.state !== "VERIFIED" && <div className="mt-1 text-xs text-slate-500">last request {formatEAT(r.last_request)}</div>}
                  </td>
                  <td className="px-3 py-2 text-slate-300">{r.verified_at ? formatEAT(r.verified_at) : "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-400">{r.gateway_ref ? r.gateway_ref.slice(0, 13) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">This view never shows a Fayda number, a name or any ID detail; the FAN is kept encrypted on the business record.</p>
    </div>
  );
}
