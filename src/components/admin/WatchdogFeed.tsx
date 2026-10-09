"use client";

import { useMemo, useState } from "react";
import { Fuel, Gauge, Landmark, Receipt, ShieldAlert, type LucideIcon } from "lucide-react";
import { formatEAT } from "@/lib/format";
import type { Merchant, WatchdogEvent, WatchdogEventType, WatchdogSeverity } from "@/lib/types";

export const EVENT_META: Record<WatchdogEventType, { label: string; blurb: string; icon: LucideIcon }> = {
  VELOCITY_SPIKE: { label: "Velocity Spike", blurb: "Rapid repeated transactions", icon: Gauge },
  ECR_MISMATCH: { label: "ECR / Fiscal Memory", blurb: "Ministry of Revenues tax integrity", icon: Receipt },
  FUEL_TELEMETRY: { label: "Fuel Forecourt", blurb: "Pump litres vs tank vs settled", icon: Fuel },
  AML_FIS_SAR: { label: "AML / FIS Feed", blurb: "Suspicious Activity Reports", icon: Landmark },
  SETTLEMENT_MISMATCH: { label: "Settlement Mismatch", blurb: "Arifpay amount ≠ quoted amount", icon: ShieldAlert },
};

const severityStyle: Record<WatchdogSeverity, string> = {
  INFO: "bg-slate-500/15 text-slate-300 ring-slate-500/30",
  WARNING: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  HIGH: "bg-orange-500/15 text-orange-300 ring-orange-500/30",
  CRITICAL: "bg-rose-500/20 text-rose-300 ring-rose-500/40",
};

const riskColor = (s: number) => (s >= 80 ? "bg-rose-500" : s >= 60 ? "bg-orange-500" : s >= 40 ? "bg-amber-500" : "bg-emerald-500");

export function WatchdogFeed({
  events,
  merchants,
  error,
}: {
  events: WatchdogEvent[];
  merchants: Record<string, Merchant>;
  error: string | null;
}) {
  const [filter, setFilter] = useState<WatchdogEventType | "ALL">("ALL");

  const counts = useMemo(() => {
    const c: Partial<Record<WatchdogEventType, number>> = {};
    for (const e of events) c[e.event_type] = (c[e.event_type] ?? 0) + 1;
    return c;
  }, [events]);

  const shown = filter === "ALL" ? events : events.filter((e) => e.event_type === filter);
  const criticalOpen = events.filter((e) => e.severity === "CRITICAL").length;

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-4">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            <ShieldAlert className="h-5 w-5 text-brand" /> 2Pay Watchdog &amp; Compliance Oracle
            <span className="flex items-center gap-1 text-xs font-normal text-slate-400">
              <span className="h-2 w-2 animate-pulse rounded-full bg-brand" /> live
            </span>
          </h2>
          <p className="text-xs text-slate-500">{criticalOpen} critical in the latest {events.length} events</p>
        </div>
        <div className="flex flex-wrap gap-1 text-xs">
          <Chip active={filter === "ALL"} onClick={() => setFilter("ALL")}>All · {events.length}</Chip>
          {(Object.keys(EVENT_META) as WatchdogEventType[]).map((t) => (
            <Chip key={t} active={filter === t} onClick={() => setFilter(t)}>
              {EVENT_META[t].label} · {counts[t] ?? 0}
            </Chip>
          ))}
        </div>
      </div>

      {error && <div className="m-4 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-300">{error}</div>}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
            <tr>
              {["Time (EAT)", "Signal", "Node", "Severity", "Risk", "Detail"].map((h) => (
                <th key={h} className="px-4 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                  {error ? "—" : "No signals. Velocity, settlement-mismatch and AML rules run automatically; ECR, fuel and FIS feeds arrive via /api/watchdog/ingest."}
                </td>
              </tr>
            )}
            {shown.map((e) => {
              const meta = EVENT_META[e.event_type] ?? { label: e.event_type, blurb: "", icon: ShieldAlert };
              const Icon = meta.icon;
              const m = e.merchant_id ? merchants[e.merchant_id] : null;
              return (
                <tr key={e.id} className="border-b border-slate-800/60 align-top last:border-0">
                  <td className="whitespace-nowrap px-4 py-3 text-slate-400">{formatEAT(e.created_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 font-medium"><Icon className="h-4 w-4 text-brand" /> {meta.label}</div>
                    <div className="text-xs text-slate-500">{meta.blurb}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    {m ? m.business_name : "—"}
                    {m && <div className="text-xs text-slate-500">{m.terminal_id}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${severityStyle[e.severity] ?? severityStyle.INFO}`}>{e.severity}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="w-7 text-right font-mono tabular-nums">{e.risk_score}</span>
                      <div className="h-1.5 w-16 overflow-hidden rounded bg-slate-800">
                        <div className={`h-full ${riskColor(e.risk_score)}`} style={{ width: `${Math.min(100, e.risk_score)}%` }} />
                      </div>
                    </div>
                  </td>
                  <td className="max-w-md px-4 py-3 text-slate-300">
                    {e.message}
                    {e.event_type === "AML_FIS_SAR" && (
                      <span className="ml-2 rounded bg-sky-500/15 px-1.5 py-0.5 text-xs text-sky-300">FIS: {String(e.details?.fis_status ?? "PENDING_FILING")}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`rounded-full px-3 py-1 font-medium ${active ? "bg-slate-700 text-white" : "bg-slate-950 text-slate-400 hover:text-slate-200"}`}>
      {children}
    </button>
  );
}
