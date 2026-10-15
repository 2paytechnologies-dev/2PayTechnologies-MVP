"use client";

import { useMemo, useState } from "react";
import { Calculator } from "lucide-react";
import { BRACKETS, VAT_PERCENT, priceTransaction } from "@/lib/pricing/engine";
import { fmt } from "@/lib/format";
import { isPaid, type Merchant, type Transaction, type WatchdogEvent } from "@/lib/types";

const money = (n: number) => n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0");
const SAMPLES = [50, 100, 300, 499.99, 500, 2500, 5000, 9999, 10000, 50000];

/** The fee schedule in force and a calculator. The schedule is fixed in code (lib/pricing/engine.ts), so what is shown here is what is charged. */
export function FeeInspector({ txs = [], events = [], merchants = [] }: { txs?: Transaction[]; events?: WatchdogEvent[]; merchants?: Merchant[] }) {
  const [amount, setAmount] = useState(1000);
  // What each node was actually charged today, from the ledger (the fee, VAT and net recorded on each sale), beside its Watchdog risk.
  const nodes = useMemo(() => {
    const hourAgo = Date.now() - 3_600_000;
    return merchants
      .map((m) => {
        const paid = txs.filter((t) => t.merchant_id === m.id && isPaid(t.status));
        const priced = paid.filter((t) => t.base_fee != null);
        const ev = events.filter((e) => e.merchant_id === m.id && new Date(e.created_at).getTime() >= hourAgo);
        const gmv = paid.reduce((s, t) => s + Number(t.amount), 0);
        const base = priced.reduce((s, t) => s + Number(t.base_fee), 0);
        const vat = priced.reduce((s, t) => s + Number(t.vat_fee ?? 0), 0);
        const net = priced.reduce((s, t) => s + Number(t.net_merchant_settlement ?? 0), 0);
        const pricedGmv = priced.reduce((s, t) => s + Number(t.amount), 0);
        return { m, taps: paid.length, legacy: paid.length - priced.length, gmv, base, vat, total: base + vat, net, rate: pricedGmv ? ((base + vat) / pricedGmv) * 100 : null, risk: ev.length ? ev.reduce((s, e) => s + e.risk_score, 0) / ev.length : 0, signals: ev.length };
      })
      .filter((n) => n.taps > 0 || merchants.length <= 12);
  }, [txs, events, merchants]);
  const totals = useMemo(() => nodes.reduce((a, n) => ({ base: a.base + n.base, vat: a.vat + n.vat, net: a.net + n.net, gmv: a.gmv + n.gmv }), { base: 0, vat: 0, net: 0, gmv: 0 }), [nodes]);
  const price = useMemo(() => priceTransaction(Math.max(1, amount)), [amount]);

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="mb-1 flex items-center gap-2 font-semibold">
        <Calculator className="h-5 w-5 text-brand" /> Orchestration fee schedule
      </h2>
      <p className="mb-4 text-xs text-slate-500">
        2Pay&apos;s fee depends on the payment amount, and {VAT_PERCENT}% VAT is added to 2Pay&apos;s fee only. Every sale records the fee before VAT, the VAT, and what the merchant is paid.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
            <tr>
              {["Amount", "Fee before VAT", `VAT ${VAT_PERCENT}%`, "Total deducted"].map((h) => (
                <th key={h} className="px-3 py-2 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {BRACKETS.map((b) => {
              const lo = priceTransaction(Math.max(0.01, b.from));
              const hi = Number.isFinite(b.to) ? priceTransaction(b.to - 0.01) : lo;
              const range = (a: number, c: number) => (a === c ? `${money(a)} ETB` : `${money(a)} to ${money(c)} ETB`);
              return (
                <tr key={b.label} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-3 py-2">{b.label}</td>
                  <td className="px-3 py-2 tabular-nums">{range(lo.base_fee, hi.base_fee)}</td>
                  <td className="px-3 py-2 tabular-nums text-slate-300">{range(lo.vat_fee, hi.vat_fee)}</td>
                  <td className="px-3 py-2 font-semibold tabular-nums">{range(lo.total_fee, hi.total_fee)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-5 grid gap-4 rounded-xl border border-slate-800 bg-slate-950 p-4 md:grid-cols-[1fr_1fr]">
        <div className="space-y-2">
          <label className="flex items-center justify-between text-xs text-slate-300">
            <span>Try an amount</span>
            <span className="font-mono tabular-nums text-white">{fmt(amount)} ETB</span>
          </label>
          <input type="range" min={1} max={50000} step={1} value={amount} onChange={(e) => setAmount(Number(e.target.value))} className="w-full accent-emerald-500" />
          <div className="flex flex-wrap gap-1.5">
            {SAMPLES.map((s) => (
              <button key={s} onClick={() => setAmount(s)} className="rounded-lg bg-slate-800 px-2 py-1 text-xs text-slate-300">{s}</button>
            ))}
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-400">Fee before VAT</dt><dd className="text-right tabular-nums">{money(price.base_fee)} ETB</dd>
          <dt className="text-slate-400">VAT ({VAT_PERCENT}% of the fee)</dt><dd className="text-right tabular-nums">{money(price.vat_fee)} ETB</dd>
          <dt className="text-slate-300">Total deducted</dt><dd className="text-right font-semibold tabular-nums">{money(price.total_fee)} ETB</dd>
          <dt className="text-slate-300">Merchant receives</dt><dd className="text-right font-bold tabular-nums text-emerald-300">{money(price.net_merchant_settlement)} ETB</dd>
        </dl>
      </div>

      <h3 className="mb-1 mt-6 text-sm font-semibold">Fee telemetry by node (today)</h3>
      <p className="mb-3 text-xs text-slate-500">
        What each node was actually charged, from the fee, VAT and net recorded on every sale. The Watchdog risk score is shown for context only: under this schedule the price depends on the amount alone, so risk does not change what a node is charged.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
            <tr>
              {["Node", "Taps", "Volume", "2Pay fee", `VAT ${VAT_PERCENT}%`, "Total deducted", "Effective rate", "Merchants receive", "Risk (1 h, not priced)"].map((h) => (
                <th key={h} className="px-3 py-2 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {nodes.length === 0 && <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-500">No paid sales today.</td></tr>}
            {nodes.map((n) => (
              <tr key={n.m.id} className="border-b border-slate-800/60 last:border-0">
                <td className="px-3 py-2"><div className="font-medium">{n.m.business_name}</div><div className="text-xs text-slate-500">{n.m.terminal_id}{n.legacy > 0 ? ` · ${n.legacy} older sale${n.legacy === 1 ? "" : "s"} without breakdown` : ""}</div></td>
                <td className="px-3 py-2 tabular-nums">{n.taps}</td>
                <td className="px-3 py-2 tabular-nums">{fmt(n.gmv)}</td>
                <td className="px-3 py-2 tabular-nums">{money(n.base)}</td>
                <td className="px-3 py-2 tabular-nums text-slate-300">{money(n.vat)}</td>
                <td className="px-3 py-2 font-semibold tabular-nums">{money(n.total)}</td>
                <td className="px-3 py-2 tabular-nums text-slate-300">{n.rate == null ? "—" : `${n.rate.toFixed(2)}%`}</td>
                <td className="px-3 py-2 tabular-nums text-emerald-300">{fmt(n.net)}</td>
                <td className="px-3 py-2 tabular-nums text-slate-400">{n.risk.toFixed(0)} <span className="text-xs text-slate-600">({n.signals} signal{n.signals === 1 ? "" : "s"})</span></td>
              </tr>
            ))}
          </tbody>
          {nodes.length > 1 && (
            <tfoot className="border-t border-slate-700 text-sm font-semibold">
              <tr>
                <td className="px-3 py-2">All nodes</td><td /><td className="px-3 py-2 tabular-nums">{fmt(totals.gmv)}</td>
                <td className="px-3 py-2 tabular-nums">{money(totals.base)}</td><td className="px-3 py-2 tabular-nums">{money(totals.vat)}</td><td className="px-3 py-2 tabular-nums">{money(totals.base + totals.vat)}</td>
                <td /><td className="px-3 py-2 tabular-nums text-emerald-300">{fmt(totals.net)}</td><td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
}
