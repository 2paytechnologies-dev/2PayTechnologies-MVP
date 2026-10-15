"use client";

import { useEffect, useState } from "react";
import { Activity, Banknote, Coins, Gauge, Landmark, ShieldCheck } from "lucide-react";
import { Logo } from "@/components/Logo";
import { useOverview } from "@/lib/use-overview";
import { RailBadge } from "@/components/RailBadge";
import { LATENCY_TARGET_S } from "@/lib/constants";
import type { SaleEvidence } from "@/lib/compliance-sales";

const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function DashboardPage() {
  // The totals come from the database already added up; the table is only the latest paid sales (a search for any other is in the admin hub).
  const { stats, error, loaded } = useOverview(5000);
  const [view, setView] = useState<"live" | "compliance">("live");
  const [latest, setLatest] = useState<SaleEvidence[]>([]);
  useEffect(() => {
    let off = false;
    const load = () =>
      fetch("/api/admin/sales?limit=25", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => !off && d && setLatest(d.sales))
        .catch(() => {});
    void load();
    const id = setInterval(load, 5000);
    return () => {
      off = true;
      clearInterval(id);
    };
  }, []);

  const avgVelocity = stats.avg_latency_ms == null ? null : stats.avg_latency_ms / 1000;
  const fees = stats.fees.base + stats.fees.vat;
  const cards = [
    { label: "Today's GMV", value: `${fmt(stats.gmv)} ETB`, icon: Banknote },
    { label: "Paid Transactions", value: stats.taps.toLocaleString(), sub: `${stats.settled.toLocaleString()} confirmed by the provider`, icon: Activity },
    {
      label: "Avg Velocity",
      value: avgVelocity == null ? "—" : `${avgVelocity.toFixed(2)}s`,
      sub: `target < ${LATENCY_TARGET_S.toFixed(1)}s`,
      icon: Gauge,
      good: avgVelocity != null && avgVelocity < LATENCY_TARGET_S,
    },
    { label: "Fees Collected (incl. VAT)", value: `${fmt(fees)} ETB`, sub: `${fmt(stats.fees.vat)} ETB of it is VAT`, icon: Coins },
  ];

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-brand">
          <Logo /> <h1 className="text-xl font-bold text-white">2Pay Executive Dashboard</h1>
          <span className="ml-2 flex items-center gap-1 text-xs text-slate-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-brand" /> live
          </span>
        </div>
        <div className="flex rounded-lg bg-slate-900 p-1 text-sm">
          {(["live", "compliance"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={`rounded-md px-3 py-1.5 font-medium ${view === v ? "bg-slate-700 text-white" : "text-slate-400"}`}>
              {v === "live" ? "Latest Transactions" : "Compliance & Non-Custodial Verification"}
            </button>
          ))}
        </div>
      </header>

      {error && <div className="mb-4 rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</div>}
      {!loaded && <div className="mb-4 text-sm text-slate-500">Loading…</div>}

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
                {["Time", "Merchant", "Amount", "Rail", "Fee (incl. VAT)", "Merchant receives"].map((h) => (
                  <th key={h} className="px-4 py-3 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {latest.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-500">No paid transactions yet. Generate one from /terminal.</td></tr>}
              {latest.map((t) => (
                <tr key={t.id} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-4 py-3 text-slate-400">{new Date(t.time).toLocaleTimeString()}</td>
                  <td className="px-4 py-3">{t.business || "—"}</td>
                  <td className="px-4 py-3 font-medium tabular-nums">{fmt(t.amount)} ETB</td>
                  <td className="px-4 py-3">{t.to_institution ? <RailBadge rail={t.to_institution as never} /> : "—"}</td>
                  <td className="px-4 py-3 tabular-nums text-slate-300">{t.base_fee == null ? "—" : fmt(t.base_fee + (t.vat_fee ?? 0))}</td>
                  <td className="px-4 py-3 tabular-nums text-slate-300">{t.net_to_merchant == null ? "—" : fmt(t.net_to_merchant)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-slate-800 px-4 py-3 text-xs text-slate-500">The latest 25 paid transactions. Search any transaction, or export a date range, in the admin hub under NBE compliance.</p>
        </section>
      ) : (
        <Compliance settled={stats.gmv} fees={fees} />
      )}
    </main>
  );
}

function Compliance({ settled, fees }: { settled: number; fees: number }) {
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
          <div className="flex items-center gap-2 text-xs text-emerald-300"><ShieldCheck className="h-4 w-4" /> Funds held by 2Pay</div>
          <div className="mt-2 text-2xl font-bold">None, by design</div>
          <div className="text-xs text-slate-400">2Pay has no balance or wallet table. The evidence is in the admin hub, NBE compliance tab.</div>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <div className="flex items-center gap-2 text-xs text-slate-400"><Landmark className="h-4 w-4 text-brand" /> Paid today, directly to merchants</div>
          <div className="mt-2 text-3xl font-bold tabular-nums">{fmt(settled)} ETB</div>
          <div className="text-xs text-slate-500">Through the licensed rails</div>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
          <div className="flex items-center gap-2 text-xs text-slate-400"><Coins className="h-4 w-4 text-brand" /> Fee revenue (incl. VAT)</div>
          <div className="mt-2 text-3xl font-bold tabular-nums">{fmt(fees)} ETB</div>
          <div className="text-xs text-slate-500">Tiered fee plus 15% VAT, deducted from the merchant</div>
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