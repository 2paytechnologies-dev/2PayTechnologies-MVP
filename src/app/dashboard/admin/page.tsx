"use client";

import { Banknote, Gauge, Network, ShieldCheck } from "lucide-react";
import { Logo } from "@/components/Logo";
import { LATENCY_TARGET_S } from "@/lib/constants";
import { fmt } from "@/lib/format";
import { useOverview } from "@/lib/use-overview";
import { WatchdogFeed } from "@/components/admin/WatchdogFeed";
import { FeeInspector } from "@/components/admin/FeeInspector";
import { AdminOps } from "@/components/admin/AdminOps";
import { NetworkNodes } from "@/components/admin/NetworkNodes";

export default function AdminHubPage() {
  const { stats, nodes, events, error: txError, eventsError: eventError } = useOverview(5000);
  const avgLatency = stats.avg_latency_ms == null ? null : stats.avg_latency_ms / 1000;
  const latencyOk = avgLatency != null && avgLatency < LATENCY_TARGET_S;

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-4 sm:p-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-brand">
          <Logo />
          <h1 className="text-xl font-bold text-white">2Pay Admin Intelligence &amp; Compliance Hub</h1>
          <span className="ml-2 flex items-center gap-1 text-xs text-slate-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-brand" /> live
          </span>
        </div>
        <span className="text-xs text-slate-500">Network telemetry · today (EAT)</span>
      </header>

      {txError && <div className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{txError}</div>}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card icon={Banknote} label="Gross Merchandise Volume" value={`${fmt(stats.gmv)} ETB`} sub="authorized + settled today" />
        <Card icon={Network} label="Total Settled Taps" value={String(stats.taps)} sub={`${stats.settled} confirmed by the provider`} />
        <Card
          icon={Gauge}
          label="Avg Initiation Latency"
          value={avgLatency == null ? "—" : `${avgLatency.toFixed(2)}s`}
          sub={`target < ${LATENCY_TARGET_S.toFixed(1)}s`}
          valueClass={avgLatency == null ? "" : latencyOk ? "text-emerald-400" : "text-rose-400"}
        />
        <Card icon={ShieldCheck} label="Critical Signals" value={String(events.filter((e) => e.severity === "CRITICAL").length)} sub="in the latest feed window" valueClass={events.some((e) => e.severity === "CRITICAL") ? "text-rose-400" : ""} />
      </section>

      <NetworkNodes stats={stats} />
      <WatchdogFeed events={events} error={eventError} />
      <FeeInspector stats={stats} nodes={nodes} />
      <AdminOps />
    </main>
  );
}
function Card({
  icon: Icon,
  label,
  value,
  sub,
  valueClass = "",
}: {
  icon: typeof Banknote;
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-center justify-between text-xs text-slate-400">
        {label} <Icon className="h-4 w-4 text-brand" />
      </div>
      <div className={`mt-2 text-2xl font-bold tabular-nums ${valueClass}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}
