"use client";

import { useEffect, useMemo, useState } from "react";
import { Banknote, Gauge, Network, ShieldCheck, Zap } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { LATENCY_TARGET_S } from "@/lib/fee";
import { eatDateKey, eatDayStartISO, fmt } from "@/lib/format";
import { isPaid, type Merchant, type Transaction, type WatchdogEvent } from "@/lib/types";
import { WatchdogFeed } from "@/components/admin/WatchdogFeed";
import { FeeInspector } from "@/components/admin/FeeInspector";

const TX_CAP = 1000;
const EVENT_CAP = 200;

export default function AdminHubPage() {
  const [txs, setTxs] = useState<Transaction[]>([]);
  const [events, setEvents] = useState<WatchdogEvent[]>([]);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [eventError, setEventError] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const since = eatDayStartISO(eatDateKey(new Date()));

    const load = async () => {
      const [t, e, m] = await Promise.all([
        supabase.from("transactions").select("*").gte("created_at", since).order("created_at", { ascending: false }).limit(TX_CAP),
        supabase.from("watchdog_events").select("*").order("created_at", { ascending: false }).limit(EVENT_CAP),
        supabase.from("merchants").select("*").order("business_name"),
      ]);
      if (cancelled) return;
      setTxError(t.error ? t.error.message : null);
      if (t.data) setTxs(t.data as Transaction[]);
      if (e.error) setEventError(`Watchdog feed unavailable (${e.error.message}). Run supabase/pilot_reconcile.sql in the Supabase SQL editor.`);
      else {
        setEventError(null);
        setEvents(e.data as WatchdogEvent[]);
      }
      if (m.data) setMerchants(m.data as Merchant[]);
    };
    void load();

    const txChannel = supabase
      .channel("admin-tx")
      .on("postgres_changes", { event: "*", schema: "public", table: "transactions" }, (payload) => {
        const row = payload.new as Transaction;
        if (!row?.id) return;
        setTxs((prev) => [row, ...prev.filter((p) => p.id !== row.id)].slice(0, TX_CAP));
      })
      .subscribe();
    const evChannel = supabase
      .channel("admin-watchdog")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "watchdog_events" }, (payload) => {
        const row = payload.new as WatchdogEvent;
        setEvents((prev) => [row, ...prev.filter((p) => p.id !== row.id)].slice(0, EVENT_CAP));
      })
      .subscribe();
    const poll = setInterval(load, 10_000); // fallback if Realtime is unavailable

    return () => {
      cancelled = true;
      clearInterval(poll);
      supabase.removeChannel(txChannel);
      supabase.removeChannel(evChannel);
    };
  }, []);

  const stats = useMemo(() => {
    const paid = txs.filter((t) => isPaid(t.status));
    const lats = paid.map((t) => t.latency_ms).filter((l): l is number => l != null);
    return {
      gmv: paid.reduce((s, t) => s + Number(t.amount), 0),
      taps: paid.length,
      settled: paid.filter((t) => t.status === "SETTLED").length,
      avgLatency: lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length / 1000 : null,
    };
  }, [txs]);

  const merchantMap = useMemo(() => Object.fromEntries(merchants.map((m) => [m.id, m])), [merchants]);
  const latencyOk = stats.avgLatency != null && stats.avgLatency < LATENCY_TARGET_S;

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-4 sm:p-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-brand">
          <Zap className="h-5 w-5" />
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
        <Card icon={Network} label="Total Settled Taps" value={String(stats.taps)} sub={`${stats.settled} confirmed by Arifpay`} />
        <Card
          icon={Gauge}
          label="Avg Initiation Latency"
          value={stats.avgLatency == null ? "—" : `${stats.avgLatency.toFixed(2)}s`}
          sub={`target < ${LATENCY_TARGET_S.toFixed(1)}s`}
          valueClass={stats.avgLatency == null ? "" : latencyOk ? "text-emerald-400" : "text-rose-400"}
        />
        <Card icon={ShieldCheck} label="Critical Signals" value={String(events.filter((e) => e.severity === "CRITICAL").length)} sub="in the latest feed window" valueClass={events.some((e) => e.severity === "CRITICAL") ? "text-rose-400" : ""} />
      </section>

      <WatchdogFeed events={events} merchants={merchantMap} error={eventError} />
      <FeeInspector txs={txs} events={events} merchants={merchants} />
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
