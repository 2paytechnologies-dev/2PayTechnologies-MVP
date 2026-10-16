"use client";

import { useEffect, useState } from "react";
import { Calculator, Loader2, ShieldAlert, TriangleAlert } from "lucide-react";
import { fmt } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { Merchant } from "@/lib/types";
import type { TaxEstimate } from "@/lib/tax";

type Answer =
  | { eligible: false; missing: ("tin" | "business_license")[] }
  | { eligible: true; verified: boolean; estimate: TaxEstimate; rules: { version: number; confirmed: boolean; confirmed_at: string | null } };

const pct = (r: number) => `${Math.round(r * 10000) / 100}%`;

/**
 * Estimated tax on what the business took through 2Pay. Shown once a TIN and a business licence are on file. Always labelled an estimate, and says
 * plainly when the rates behind it have not yet been confirmed against current law.
 */
export function TaxTab({ merchant, onOpenProfile }: { merchant: Merchant; onOpenProfile?: () => void }) {
  const t = useT();
  const nowYear = new Date().getFullYear();
  const [year, setYear] = useState(nowYear);
  const [data, setData] = useState<Answer | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setData(null);
    setFailed(false);
    fetch(`/api/merchants/${merchant.id}/tax?year=${year}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const d = (await r.json()) as Answer;
        if (live) setData(d);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [merchant.id, year]);

  const etb = t("common.etb");
  if (failed) return <p className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{t("tax.error")}</p>;
  if (!data) return <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-500" />;

  if (!data.eligible) {
    return (
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Calculator className="h-5 w-5 text-brand" /> {t("tax.needs.title")}
        </h2>
        <p className="mt-1 text-sm text-slate-400">{t("tax.needs.body")}</p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-300">
          {data.missing.includes("tin") && <li>{t("tax.needs.tin")}</li>}
          {data.missing.includes("business_license") && <li>{t("tax.needs.license")}</li>}
        </ul>
        {onOpenProfile && (
          <button onClick={onOpenProfile} className="mt-4 rounded-xl bg-brand px-4 py-2.5 font-bold text-slate-950">
            {t("tax.needs.cta")}
          </button>
        )}
      </section>
    );
  }

  const e = data.estimate;
  const note = e.regime === "VAT" ? t("tax.regime.vatNote", { threshold: fmt(e.vatThreshold), rate: pct(e.rate) }) : t("tax.regime.turnoverNote", { threshold: fmt(e.vatThreshold), rate: pct(e.rate) });
  const tile = (label: string, value: number, strong = false) => (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <div className="text-xs text-slate-400">{label}</div>
      <div className={strong ? "mt-1 text-2xl font-bold tabular-nums text-brand" : "mt-1 text-2xl font-bold tabular-nums"}>
        {fmt(value)} <span className="text-sm font-normal text-slate-400">{etb}</span>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Calculator className="h-5 w-5 text-brand" /> {t("tax.title")} · {t(e.regime === "VAT" ? "tax.regime.VAT" : "tax.regime.TURNOVER")}
        </h2>
        <label className="flex items-center gap-2 text-sm text-slate-400">
          {t("tax.year")}
          <select value={year} onChange={(ev) => setYear(Number(ev.target.value))} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100">
            {[nowYear, nowYear - 1, nowYear - 2].map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!data.rules.confirmed && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" /> <span>{t("tax.unconfirmed")}</span>
        </div>
      )}
      {data.rules.confirmed && data.rules.confirmed_at && <p className="text-xs text-emerald-300">{t("tax.confirmed", { date: new Date(data.rules.confirmed_at).toLocaleDateString() })}</p>}
      {!data.verified && (
        <div className="flex items-start gap-2 rounded-xl border border-slate-700 bg-slate-900 p-3 text-sm text-slate-300">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> <span>{t("tax.unverified")}</span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tile(t("tax.tile.ytd"), e.ytd.turnover)}
        {tile(t("tax.tile.ytdTax"), e.ytd.tax, true)}
        {tile(t("tax.tile.projected"), e.projected.turnover)}
        {tile(t("tax.tile.projectedTax"), e.projected.tax, true)}
      </div>

      <p className="text-sm text-slate-400">
        {note} {e.regime === "VAT" && <>{e.inclusive ? t("tax.vatInclusive") : t("tax.vatExclusive")}</>}
      </p>

      {e.months.length === 0 ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900 p-6 text-center text-sm text-slate-500">{t("tax.none")}</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900">
          <table className="w-full min-w-[420px] text-left text-sm">
            <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
              <tr>
                <th className="px-3 py-2 font-medium">{t("tax.col.month")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("tax.col.sales")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("tax.col.turnover")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("tax.col.tax")}</th>
              </tr>
            </thead>
            <tbody>
              {e.months.map((m) => (
                <tr key={m.month} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-3 py-2 tabular-nums">{m.month}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{m.sales}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(m.turnover)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(m.tax)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-slate-500">{t("tax.disclaimer")}</p>
    </div>
  );
}
