"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Banknote, CheckCircle2, Clock, Printer, ShieldAlert } from "lucide-react";
import { eatDateKey, eatDayEndISO, eatDayStartISO, fmt } from "@/lib/format";
import { countWatchdogEvents, fetchTransactions } from "@/lib/tx-query";
import { isPaid, type Merchant, type Transaction } from "@/lib/types";
import { printPage } from "@/lib/native";
import { useI18n } from "@/lib/i18n";

/** A paid tap not confirmed by the rail within this window counts as unreconciled. */
const RECONCILE_GRACE_MS = 10 * 60_000;

type Recon = { kind: "ok" } | { kind: "pending"; count: number } | { kind: "mismatch"; count: number };

export function BriefingTab({ merchant }: { merchant: Merchant }) {
  const { t, lang } = useI18n();
  const [rows, setRows] = useState<Transaction[]>([]);
  const [mismatches, setMismatches] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const day = eatDateKey(new Date());
    const from = eatDayStartISO(day);
    try {
      const [tx, alerts] = await Promise.allSettled([fetchTransactions(merchant.id, from, eatDayEndISO(day)), countWatchdogEvents(merchant.id, "SETTLEMENT_MISMATCH", from)]);
      if (tx.status === "rejected") throw tx.reason;
      setRows(tx.value.rows);
      setMismatches(alerts.status === "fulfilled" ? alerts.value : 0);
      setNow(Date.now());
      setError(alerts.status === "rejected" ? t("today.alertsUnavailable") : null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [merchant.id, t]);

  useEffect(() => {
    void load();
    const poll = setInterval(load, 10_000); // refresh while the briefing is open
    return () => clearInterval(poll);
  }, [load]);

  const brief = useMemo(() => {
    const paid = rows.filter((r) => isPaid(r.status));
    const settledMs = rows
      .filter((r) => r.status === "SETTLED" && r.settled_at)
      .map((r) => new Date(r.settled_at!).getTime() - new Date(r.created_at).getTime())
      .filter((ms) => ms >= 0);
    const authMs = paid.map((r) => r.latency_ms).filter((l): l is number => l != null);
    // Prefer true end-to-end settlement time; fall back to authorization latency until the rail confirms.
    const sample = settledMs.length ? settledMs : authMs;
    const stale = paid.filter((r) => r.status === "SUCCESS" && now - new Date(r.created_at).getTime() > RECONCILE_GRACE_MS).length;
    const recon: Recon = mismatches > 0 ? { kind: "mismatch", count: mismatches } : stale > 0 ? { kind: "pending", count: stale } : { kind: "ok" };

    // End-of-day report data
    const byMethod = new Map<string, { count: number; total: number }>();
    for (const r of paid) {
      const m = byMethod.get(r.rail) ?? { count: 0, total: 0 };
      m.count++;
      m.total += Number(r.amount);
      byMethod.set(r.rail, m);
    }
    return {
      gross: paid.reduce((s, r) => s + Number(r.amount), 0),
      fees: paid.reduce((s, r) => s + Number(r.fee_ft), 0),
      count: paid.length,
      unpaid: rows.filter((r) => r.status === "FAILED" || (r.status === "PENDING" && new Date(r.expires_at).getTime() < now)).length,
      avgSeconds: sample.length ? sample.reduce((a, b) => a + b, 0) / sample.length / 1000 : null,
      basis: settledMs.length ? "settled" : "authorized",
      recon,
      methods: [...byMethod.entries()].sort((a, b) => b[1].total - a[1].total),
    };
  }, [rows, mismatches, now]);

  const reconView = {
    ok: { text: t("today.recon.ok"), cls: "text-emerald-400", Icon: CheckCircle2 },
    pending: { text: t("today.recon.pending", { n: (brief.recon as { count?: number }).count ?? 0 }), cls: "text-amber-400", Icon: Clock },
    mismatch: { text: t("today.recon.mismatch", { n: (brief.recon as { count?: number }).count ?? 0 }), cls: "text-rose-400", Icon: ShieldAlert },
  }[brief.recon.kind];

  const etb = t("common.etb");
  const dateLabel = new Date().toLocaleDateString(lang === "am" ? "am-ET-u-ca-gregory-nu-latn" : "en-GB", { timeZone: "Africa/Addis_Ababa", weekday: "long", day: "numeric", month: "long", year: "numeric" });

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">{t("today.title")}</h2>
          <span className="text-xs text-slate-500">
            {dateLabel} · {merchant.business_name}
          </span>
        </div>

        {error && <div className="mb-4 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-300">{error}</div>}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile icon={<Banknote className="h-4 w-4 text-brand" />} label={t("today.tile.gross")} value={`${fmt(brief.gross)} ${etb}`} />
          <Tile icon={<Activity className="h-4 w-4 text-brand" />} label={t("today.tile.count")} value={String(brief.count)} />
          <Tile
            icon={<Clock className="h-4 w-4 text-brand" />}
            label={t("today.tile.avg")}
            value={brief.avgSeconds == null ? "—" : `${brief.avgSeconds.toFixed(1)}s`}
            sub={brief.avgSeconds == null ? undefined : brief.basis === "settled" ? t("today.avg.settled") : t("today.avg.authorized")}
          />
          <Tile icon={<reconView.Icon className={`h-4 w-4 ${reconView.cls}`} />} label={t("today.tile.recon")} value={reconView.text} valueClass={reconView.cls} />
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{t("today.report.title")}</h2>
          <button onClick={printPage} className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-bold text-slate-950">
            <Printer className="h-4 w-4" /> {t("today.report.print")}
          </button>
        </div>

        {/* The printable sheet: black on white, only this block is printed. */}
        <div id="print-area" className="rounded-xl bg-white p-6 text-slate-900">
          <div className="border-b border-slate-300 pb-3">
            <div className="text-xl font-extrabold">{merchant.business_name}</div>
            <div className="text-sm text-slate-600">
              {merchant.terminal_id} · {t("today.report.forDate", { date: dateLabel })}
            </div>
          </div>
          {brief.methods.length === 0 ? (
            <p className="py-6 text-sm text-slate-600">{t("today.report.none")}</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="border-b border-slate-300 text-left text-xs uppercase text-slate-500">
                  <th className="py-2">{t("today.report.method")}</th>
                  <th className="py-2 text-right">{t("today.report.sales")}</th>
                  <th className="py-2 text-right">{t("today.report.total")}</th>
                </tr>
              </thead>
              <tbody>
                {brief.methods.map(([method, m]) => (
                  <tr key={method} className="border-b border-slate-200">
                    <td className="py-2">{method}</td>
                    <td className="py-2 text-right tabular-nums">{m.count}</td>
                    <td className="py-2 text-right tabular-nums">
                      {fmt(m.total)} {etb}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <dl className="mt-4 space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="font-bold">{t("today.report.gross")}</dt>
              <dd className="font-bold tabular-nums">
                {fmt(brief.gross)} {etb} ({brief.count})
              </dd>
            </div>
            <div className="flex justify-between text-slate-600">
              <dt>{t("today.report.fees")}</dt>
              <dd className="tabular-nums">
                {fmt(brief.fees)} {etb}
              </dd>
            </div>
            <div className="flex justify-between text-slate-600">
              <dt>{t("today.report.unpaid")}</dt>
              <dd className="tabular-nums">{brief.unpaid}</dd>
            </div>
          </dl>
          <p className="mt-8 text-xs text-slate-500">{t("today.report.signoff")}</p>
        </div>
      </section>
    </div>
  );
}

function Tile({ icon, label, value, sub, valueClass = "" }: { icon: React.ReactNode; label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>{label}</span>
        {icon}
      </div>
      <div className={`mt-2 text-2xl font-bold tabular-nums ${valueClass}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}
