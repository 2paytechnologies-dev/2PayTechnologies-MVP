"use client";

import { useMemo, useState } from "react";
import { Calculator } from "lucide-react";
import { FEE_PARAMS, LATENCY_TARGET_S, feeBreakdown, type FeeParams } from "@/lib/fee";
import { fmt } from "@/lib/format";
import { isPaid, type Merchant, type Transaction, type WatchdogEvent } from "@/lib/types";

const HOUR = 3_600_000;

const SLIDERS: { key: keyof FeeParams; label: string; sym: string; min: number; max: number; step: number }[] = [
  { key: "base", label: "Base fee", sym: "B_base", min: 0, max: 1, step: 0.01 },
  { key: "alpha", label: "Value coefficient", sym: "α", min: 0, max: 0.02, step: 0.0005 },
  { key: "beta", label: "Risk premium / point", sym: "β", min: 0, max: 0.02, step: 0.0005 },
  { key: "gamma", label: "Traffic surcharge / s", sym: "γ", min: 0, max: 0.5, step: 0.005 },
  { key: "delta", label: "Loyalty credit / tap", sym: "δ", min: 0, max: 0.005, step: 0.0001 },
];

export function FeeInspector({
  txs,
  events,
  merchants,
}: {
  txs: Transaction[];
  events: WatchdogEvent[];
  merchants: Merchant[];
}) {
  const [params, setParams] = useState<FeeParams>(FEE_PARAMS);
  const [sample, setSample] = useState(1000);

  // Live per-node drivers: R_t from the last hour of watchdog events, T_t from mean latency, C_t from settled taps.
  const nodes = useMemo(() => {
    const cutoff = Date.now() - HOUR;
    return merchants.map((m) => {
      const ev = events.filter((e) => e.merchant_id === m.id && new Date(e.created_at).getTime() >= cutoff);
      const paid = txs.filter((t) => t.merchant_id === m.id && isPaid(t.status));
      const lats = paid.map((t) => t.latency_ms).filter((l): l is number => l != null);
      const risk = ev.length ? ev.reduce((s, e) => s + e.risk_score, 0) / ev.length : 0;
      const meanLat = lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length / 1000 : 0;
      const traffic = Math.max(0, meanLat - LATENCY_TARGET_S);
      const credit = paid.length;
      const live = feeBreakdown({ volume: sample, risk, traffic, credit }, params);
      const neutral = feeBreakdown({ volume: sample, risk: 0, traffic: 0, credit }, params);
      return { m, risk, traffic, credit, signals: ev.length, live, premium: live.fee - neutral.fee };
    });
  }, [merchants, events, txs, sample, params]);

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="mb-1 flex items-center gap-2 font-semibold">
        <Calculator className="h-5 w-5 text-brand" /> Algorithmic Orchestration Fee Inspector
      </h2>
      <p className="mb-4 text-xs text-slate-500">Adjust the coefficients to see how each node&apos;s live telemetry reprices the fee. Changes here are a what-if view and do not alter billing.</p>

      <div className="rounded-xl border border-brand/30 bg-slate-950 p-4 text-center font-mono text-lg sm:text-xl">
        F<sub>t</sub> = B<sub>base</sub> + (α · V<sub>t</sub>) + (β · R<sub>t</sub>) + (γ · T<sub>t</sub>) − δ(C<sub>t</sub>)
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-left font-sans text-xs text-slate-400 sm:grid-cols-4">
          <span><b className="text-slate-200">V<sub>t</sub></b> transaction value (ETB)</span>
          <span><b className="text-slate-200">R<sub>t</sub></b> Watchdog risk score 0–100</span>
          <span><b className="text-slate-200">T<sub>t</sub></b> seconds over the {LATENCY_TARGET_S.toFixed(1)}s latency target</span>
          <span><b className="text-slate-200">C<sub>t</sub></b> settled taps (loyalty), credit capped at {params.creditCap} ETB</span>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3 lg:grid-cols-6">
        <div className="md:col-span-3 lg:col-span-6">
          <label className="flex items-center justify-between text-xs text-slate-300">
            <span>Sample transaction value V<sub>t</sub></span>
            <span className="font-mono tabular-nums text-white">{fmt(sample)} ETB</span>
          </label>
          <input type="range" min={50} max={50000} step={50} value={sample} onChange={(e) => setSample(Number(e.target.value))} className="w-full accent-emerald-500" />
        </div>
        {SLIDERS.map((s) => (
          <div key={s.key}>
            <label className="flex items-center justify-between text-xs text-slate-300">
              <span>{s.label}</span>
              <span className="font-mono tabular-nums text-white">{s.sym} = {params[s.key]}</span>
            </label>
            <input
              type="range"
              min={s.min}
              max={s.max}
              step={s.step}
              value={params[s.key]}
              onChange={(e) => setParams((p) => ({ ...p, [s.key]: Number(e.target.value) }))}
              className="w-full accent-emerald-500"
            />
          </div>
        ))}
        <button onClick={() => setParams(FEE_PARAMS)} className="self-end rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-300">Reset to live values</button>
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
            <tr>
              {["Active node", "R_t risk", "T_t traffic", "C_t taps", "B_base", "α·V_t", "β·R_t (risk premium)", "γ·T_t", "−δ(C_t)", "F_t"].map((h) => (
                <th key={h} className="px-3 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {nodes.length === 0 && <tr><td colSpan={10} className="px-3 py-8 text-center text-slate-500">No nodes.</td></tr>}
            {nodes.map(({ m, risk, traffic, credit, signals, live, premium }) => (
              <tr key={m.id} className="border-b border-slate-800/60 last:border-0">
                <td className="px-3 py-3">
                  <div className="font-medium">{m.business_name}</div>
                  <div className="text-xs text-slate-500">{m.terminal_id} · {signals} signal{signals === 1 ? "" : "s"}/h</div>
                </td>
                <td className="px-3 py-3 tabular-nums">{risk.toFixed(0)}</td>
                <td className="px-3 py-3 tabular-nums">{traffic.toFixed(2)}s</td>
                <td className="px-3 py-3 tabular-nums">{credit}</td>
                <td className="px-3 py-3 tabular-nums text-slate-300">{live.base.toFixed(3)}</td>
                <td className="px-3 py-3 tabular-nums text-slate-300">{live.volumeTerm.toFixed(3)}</td>
                <td className={`px-3 py-3 tabular-nums ${live.riskTerm > 0 ? "font-semibold text-orange-300" : "text-slate-300"}`}>
                  {live.riskTerm.toFixed(3)}
                  {premium > 0.005 && <span className="ml-1 text-xs text-orange-400">+{premium.toFixed(2)}</span>}
                </td>
                <td className="px-3 py-3 tabular-nums text-slate-300">{live.trafficTerm.toFixed(3)}</td>
                <td className="px-3 py-3 tabular-nums text-emerald-300">−{live.creditTerm.toFixed(3)}</td>
                <td className="px-3 py-3 font-bold tabular-nums">
                  {fmt(live.fee)} ETB
                  {live.floored && <span className="ml-1 text-xs font-normal text-slate-500">(floor)</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
