"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarRange, Download, Loader2 } from "lucide-react";
import { eatDateKey, eatDayEndISO, eatDayStartISO, fmt, formatEAT, downloadFile, referenceFor, toCSV } from "@/lib/format";
import { fetchTransactions } from "@/lib/tx-query";
import { isPaid, type Merchant, type Transaction } from "@/lib/types";
import { StatusBadge } from "@/components/RailBadge";

type Preset = "today" | "7d" | "30d" | "custom";
const PRESETS: { id: Preset; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 Days" },
  { id: "30d", label: "30 Days" },
  { id: "custom", label: "Custom Range" },
];
const MAX_SPAN_DAYS = 365;
const DAY_MS = 86_400_000;

const daysAgoKey = (n: number) => eatDateKey(new Date(Date.now() - n * DAY_MS));

/** Whole days between now and the next Dec 31 (EAT), for the archival countdown. */
function daysUntilYearEnd(): number {
  const year = Number(eatDateKey(new Date()).slice(0, 4));
  const end = new Date(`${year}-12-31T23:59:59+03:00`).getTime();
  return Math.max(0, Math.ceil((end - Date.now()) / DAY_MS));
}

export function LookbackTab({ merchant }: { merchant: Merchant }) {
  const [preset, setPreset] = useState<Preset>("7d");
  const [customFrom, setCustomFrom] = useState(daysAgoKey(7));
  const [customTo, setCustomTo] = useState(daysAgoKey(0));
  const [rows, setRows] = useState<Transaction[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(() => {
    const to = preset === "custom" ? customTo : daysAgoKey(0);
    const from = preset === "today" ? daysAgoKey(0) : preset === "7d" ? daysAgoKey(6) : preset === "30d" ? daysAgoKey(29) : customFrom;
    return { from, to };
  }, [preset, customFrom, customTo]);

  const rangeError = useMemo(() => {
    if (!range.from || !range.to) return "Pick both dates.";
    if (range.from > range.to) return "Start date must be on or before the end date.";
    const span = (new Date(range.to).getTime() - new Date(range.from).getTime()) / DAY_MS + 1;
    if (span > MAX_SPAN_DAYS) return `Range is limited to ${MAX_SPAN_DAYS} days (data is retained for 365 days).`;
    return null;
  }, [range]);

  const load = useCallback(async () => {
    if (rangeError) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchTransactions(merchant.id, eatDayStartISO(range.from), eatDayEndISO(range.to));
      setRows(res.rows);
      setTruncated(res.truncated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [merchant.id, range, rangeError]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => {
    const paid = rows.filter((r) => isPaid(r.status));
    return {
      gross: paid.reduce((s, r) => s + Number(r.amount), 0),
      paid: paid.length,
      settled: rows.filter((r) => r.status === "SETTLED").length,
      fees: paid.reduce((s, r) => s + Number(r.fee_ft), 0),
    };
  }, [rows]);

  const exportYear = async () => {
    setExporting(true);
    setError(null);
    try {
      const fromKey = daysAgoKey(364);
      const toKey = daysAgoKey(0);
      const { rows: all, truncated: cut } = await fetchTransactions(merchant.id, eatDayStartISO(fromKey), eatDayEndISO(toKey), 200_000);
      if (cut) throw new Error("Too many records to export in one file. Narrow the range and export in parts.");
      const csv = toCSV(
        ["Reference", "Created (EAT)", "Merchant", "Terminal", "Amount", "Currency", "Status", "Rail", "Orchestration Fee", "Latency (s)", "Settled At (EAT)", "Settled Amount", "Arifpay Ref"],
        all.map((t) => [
          referenceFor(t.id),
          formatEAT(t.created_at),
          merchant.business_name,
          merchant.terminal_id,
          Number(t.amount).toFixed(2),
          t.currency,
          t.status,
          t.rail,
          Number(t.fee_ft).toFixed(2),
          t.latency_ms != null ? (t.latency_ms / 1000).toFixed(2) : null,
          t.settled_at ? formatEAT(t.settled_at) : null,
          t.settled_amount != null ? Number(t.settled_amount).toFixed(2) : null,
          t.arifpay_ref,
        ]),
      );
      downloadFile(`2pay-${merchant.terminal_id}-${fromKey}_to_${toKey}.csv`, csv, "text/csv;charset=utf-8");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const days = daysUntilYearEnd();

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
        <div className="min-w-[16rem] flex-1 space-y-1">
          <p>
            ⚠️ Annual Data Archival: Transaction logs are retained for 365 days. Your annual cycle resets on December 31. Please download your annual records for tax
            and bookkeeping.
          </p>
          <p className="text-xs text-amber-300/80">{days} day{days === 1 ? "" : "s"} until December 31.</p>
        </div>
        <button
          onClick={exportYear}
          disabled={exporting}
          className="ml-auto inline-flex shrink-0 items-center gap-2 rounded-xl bg-amber-400 px-4 py-2 font-semibold text-slate-950 disabled:opacity-60"
        >
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Export Full Year CSV
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <CalendarRange className="h-5 w-5 text-brand" />
        <div className="flex rounded-lg bg-slate-950 p-1 text-sm">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPreset(p.id)}
              className={`rounded-md px-3 py-1.5 font-medium ${preset === p.id ? "bg-slate-700 text-white" : "text-slate-400"}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <input
              type="date"
              value={customFrom}
              max={customTo}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 [color-scheme:dark]"
            />
            <span className="text-slate-500">to</span>
            <input
              type="date"
              value={customTo}
              min={customFrom}
              max={daysAgoKey(0)}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 [color-scheme:dark]"
            />
          </div>
        )}
        <span className="ml-auto text-xs text-slate-500">
          {range.from} → {range.to} (EAT)
        </span>
      </div>

      {(rangeError || error) && <div className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{rangeError ?? error}</div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Gross takings" value={`${fmt(summary.gross)} ETB`} />
        <Stat label="Paid transactions" value={String(summary.paid)} />
        <Stat label="Settled by Arifpay" value={String(summary.settled)} />
        <Stat label="Orchestration fees" value={`${fmt(summary.fees)} ETB`} />
      </div>

      <section className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
            <tr>
              {["Time (EAT)", "Reference", "Amount", "Rail", "Status"].map((h) => (
                <th key={h} className="px-4 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-500"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-500">No transactions in this range.</td></tr>
            )}
            {!loading &&
              rows.slice(0, 100).map((t) => (
                <tr key={t.id} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-4 py-3 text-slate-400">{formatEAT(t.created_at)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-300">{referenceFor(t.id)}</td>
                  <td className="px-4 py-3 font-medium tabular-nums">{fmt(Number(t.amount))} {t.currency}</td>
                  <td className="px-4 py-3 text-slate-300">{t.rail}</td>
                  <td className="px-4 py-3"><StatusBadge status={t.status} /></td>
                </tr>
              ))}
          </tbody>
        </table>
        {!loading && rows.length > 100 && (
          <div className="border-t border-slate-800 px-4 py-2 text-xs text-slate-500">
            Showing the latest 100 of {rows.length}{truncated ? "+" : ""} records. Export CSV for the full set.
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-2 text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}
