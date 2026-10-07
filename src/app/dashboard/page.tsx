"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, Banknote, Coins, Gauge, Landmark, ShieldCheck, Zap } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { Merchant, Transaction } from "@/lib/types";
import { RailBadge, StatusBadge } from "@/components/RailBadge";

const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export default function DashboardPage() {
  const [txs, setTxs] = useState<Transaction[]>([]);
  const [merchants, setMerchants] = useState<Record<string, Merchant>>({});
  const [view, setView] = useState<"live" | "compliance">("live");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [{ data: t }, { data: m }] = await Promise.all([
        supabase.from("transactions").select("*").gte("created_at", startOfToday()).order("created_at", { ascending: false }).limit(200),
        supabase.from("merchants").select("*"),
      ]);
      if (cancelled) return;
      setTxs((t as Transaction[]) ?? []);
      setMerchants(Object.fromEntries(((m as Merchant[]) ?? []).map((x) => [x.id, x])));
    };
    load();

    const channel = supabase
      .channel("dashboard-tx")
      .on("postgres_changes", { event: "*", schema: "public", table: "transactions" }, (payload) => {
        const row = payload.new as Transaction;
        setTxs((prev) => [row, ...prev.filter((p) => p.id !== row.id)].slice(0, 200));
      })
      .subscribe();
    const poll = setInterval(load, 5000); // fallback if Realtime is unavailable

    return () => {
      cancelled = true;
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, []);

  const stats = useMemo(() => {
    const ok = txs.filter((t) => t.status === "SUCCESS");
    const lat = ok.map((t) => t.latency_ms).filter((l): l is number => l != null);
    return {
      gmv: ok.reduce((s, t) => s + Number(t.amount), 0),
      count: txs.length,
      success: ok.length,
      avgVelocity: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length / 1000 : null,
      fees: ok.reduce((s, t) => s + Number(t.fee_ft), 0),
    };
  }, [txs]);

  const cards = [
    { label: "Today's GMV", value: `${fmt(stats.gmv)} ETB`, icon: Banknote },
    { label: "Total Transactions", value: `${stats.count}`, sub: `${stats.success} settled`, icon: Activity },
    {
      label: "Avg Velocity",
      value: stats.avgVelocity == null ? "—" : `${stats.avgVelocity.toFixed(2)}s`,
      sub: "target < 2s",
      icon: Gauge,
      good: stats.avgVelocity != null && stats.avgVelocity < 2,
    },
    { label: "Algorithmic Fees Collected", value: `${fmt(stats.fees)} ETB`, icon: Coins },
  ];

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-brand">
          <Zap className="h-5 w-5" /> <h1 className="text-xl font-bold text-white">2Pay Executive Dashboard</h1>
          <span className="ml-2 flex items-center gap-1 text-xs text-slate-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-brand" /> live
          </span>
        </div>
        <div className="flex rounded-lg bg-slate-900 p-1 text-sm">
          {(["live", "compliance"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded-md px-3 py-1.5 font-medium ${view === v ? "bg-slate-700 text-white" : "text-slate-400"}`}
            >
              {v === "live" ? "Live Transactions" : "Compliance & Non-Custodial Verification"}
            </button>
          ))}
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map(({ label, value, sub, icon: Icon, good }) => (
          <div key={label} className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
            <div className="flex items-center justify-between text-xs text-slate-400">
              {label} <Icon className="h-4 w-4 text-brand" />
            </div>
            <div className={`mt-2 text-2xl font-bold tabular-nums ${good ? "text-emerald-400" : ""}`}>{value}</div>
            {sub && <div className="text-xs text-slate-500">{sub}</div>}
          </div>
        ))}
      </section>

      {view === "live" ? (
        <section className="mt-6 overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
              <tr>
                {["Time", "Merchant", "Amount", "Rail", "Fee", "Latency", "Status"].map((h) => (
                  <th key={h} className="px-4 py-3 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {txs.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-500">No transactions yet today — generate one from /terminal.</td></tr>
              )}
              {txs.map((t) => (
                <tr key={t.id} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-4 py-3 text-slate-400">{new Date(t.created_at).toLocaleTimeString()}</td>
                  <td className="px-4 py-3">{merchants[t.merchant_id]?.business_name ?? "—"}</td>
                  <td className="px-4 py-3 font-medium tabular-nums">{fmt(Number(t.amount))} {t.currency}</td>
                  <td className="px-4 py-3"><RailBadge rail={t.rail} /></td>
                  <td className="px-4 py-3 tabular-nums text-slate-300">{t.status === "SUCCESS" ? fmt(Number(t.fee_ft)) : "—"}</td>
                  <td className="px-4 py-3 tabular-nums text-slate-300">{t.latency_ms != null ? `${(t.latency_ms / 1000).toFixed(2)}s` : "—"}</td>
                  <td className="px-4 py-3"><StatusBadge status={t.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <Compliance float={0} settled={stats.gmv} fees={stats.fees} />
      )}
    </main>
  );
}

function Compliance({ settled, fees }: { float: number; settled: number; fees: number }) {
  const hops = [
    { title: "Customer Wallet", body: "Holds funds. Issues inherited biometric / PIN authorization." },
    { title: "2Pay Orchestration", body: "Issues single-use token and routing instruction only. No funds, no ledger of balances.", highlight: true },
    { title: "Arifpay / EthioPay-IPS", body: "Licensed rails clear and settle the transfer." },
    { title: "Merchant Account", body: "Funds land directly in the merchant's bank / wallet." },
  ];
  return (
    <section className="mt-6 space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4">
          <div className="flex items-center gap-2 text-xs text-emerald-300"><ShieldCheck className="h-4 w-4" /> 2Pay Float Held</div>
          <div className="mt-2 text-3xl font-bold">0.00 ETB</div>
          <div className="text-xs text-slate-400">Zero-float · non-custodial</div>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <div className="flex items-center gap-2 text-xs text-slate-400"><Landmark className="h-4 w-4 text-brand" /> Settled Directly to Merchants</div>
          <div className="mt-2 text-3xl font-bold tabular-nums">{fmt(settled)} ETB</div>
          <div className="text-xs text-slate-500">Today, via licensed rails</div>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <div className="flex items-center gap-2 text-xs text-slate-400"><Coins className="h-4 w-4 text-brand" /> Fee Revenue</div>
          <div className="mt-2 text-3xl font-bold tabular-nums">{fmt(fees)} ETB</div>
          <div className="text-xs text-slate-500">Algorithmic fee, billed separately</div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="mb-4 font-semibold">Direct settlement routing</h2>
        <ol className="grid gap-3 md:grid-cols-4">
          {hops.map((h, i) => (
            <li key={h.title} className={`rounded-xl border p-4 ${h.highlight ? "border-brand bg-brand/10" : "border-slate-800 bg-slate-950"}`}>
              <div className="text-xs text-slate-500">Step {i + 1}</div>
              <div className="font-semibold">{h.title}</div>
              <p className="mt-1 text-sm text-slate-400">{h.body}</p>
            </li>
          ))}
        </ol>
        <ul className="mt-5 space-y-1 text-sm text-slate-300">
          <li>✔ Tokens are single-use with a 90-second TTL, enforced atomically in the database.</li>
          <li>✔ No transaction amount is ever credited to a 2Pay-controlled account.</li>
          <li>✔ Authorization is inherited from the customer&apos;s wallet; 2Pay stores no credentials.</li>
        </ul>
      </div>
    </section>
  );
}
