"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarRange, Download, Loader2, RotateCcw } from "lucide-react";
import { eatDateKey, eatDayEndISO, eatDayStartISO, fmt, formatEAT, downloadFile, referenceFor, toCSV } from "@/lib/format";
import { fetchTransactions } from "@/lib/tx-query";
import { isPaid, type Merchant, type Transaction } from "@/lib/types";
import { StatusBadge } from "@/components/RailBadge";
import { useT, type Key } from "@/lib/i18n";

type Preset = "today" | "7d" | "30d" | "custom";
const PRESETS: { id: Preset; key: Key }[] = [
  { id: "today", key: "common.today" },
  { id: "7d", key: "sales.range.7d" },
  { id: "30d", key: "sales.range.30d" },
  { id: "custom", key: "sales.range.custom" },
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

interface RefundRow {
  id: string;
  reference: string;
  amount: number;
  reason: string;
  status: "REQUESTED" | "APPROVED" | "REFUNDED" | "REJECTED";
  admin_note: string | null;
  created_at: string;
}

export function LookbackTab({ merchant }: { merchant: Merchant }) {
  const t = useT();
  const [preset, setPreset] = useState<Preset>("7d");
  const [customFrom, setCustomFrom] = useState(daysAgoKey(7));
  const [customTo, setCustomTo] = useState(daysAgoKey(0));
  const [rows, setRows] = useState<Transaction[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refunds, setRefunds] = useState<RefundRow[]>([]);
  const [refundFor, setRefundFor] = useState<Transaction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const range = useMemo(() => {
    const to = preset === "custom" ? customTo : daysAgoKey(0);
    const from = preset === "today" ? daysAgoKey(0) : preset === "7d" ? daysAgoKey(6) : preset === "30d" ? daysAgoKey(29) : customFrom;
    return { from, to };
  }, [preset, customFrom, customTo]);

  const rangeError = useMemo(() => {
    if (!range.from || !range.to) return t("sales.pickBoth");
    if (range.from > range.to) return t("sales.startAfterEnd");
    const span = (new Date(range.to).getTime() - new Date(range.from).getTime()) / DAY_MS + 1;
    if (span > MAX_SPAN_DAYS) return t("sales.tooLong", { n: MAX_SPAN_DAYS });
    return null;
  }, [range, t]);

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

  const loadRefunds = useCallback(async () => {
    try {
      const r = await fetch(`/api/refunds?merchant_id=${merchant.id}`, { cache: "no-store" });
      if (r.ok) setRefunds(await r.json());
    } catch {
      /* the list is secondary */
    }
  }, [merchant.id]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadRefunds();
  }, [loadRefunds]);

  const summary = useMemo(() => {
    const paid = rows.filter((r) => isPaid(r.status));
    return {
      gross: paid.reduce((s, r) => s + Number(r.amount), 0),
      paid: paid.length,
      settled: rows.filter((r) => r.status === "SETTLED").length,
      fees: paid.reduce((s, r) => s + Number(r.fee_ft), 0),
    };
  }, [rows]);

  const openRefundIds = useMemo(() => new Set(refunds.filter((r) => r.status === "REQUESTED" || r.status === "APPROVED").map((r) => r.reference)), [refunds]);

  const exportYear = async () => {
    setExporting(true);
    setError(null);
    try {
      const fromKey = daysAgoKey(364);
      const toKey = daysAgoKey(0);
      const { rows: all, truncated: cut } = await fetchTransactions(merchant.id, eatDayStartISO(fromKey), eatDayEndISO(toKey), 200_000);
      if (cut) throw new Error(t("sales.exportTooMany"));
      // The CSV stays in English: it is an accounting file shared with bookkeepers and tax offices.
      const csv = toCSV(
        ["Reference", "Created (EAT)", "Merchant", "Terminal", "Amount", "Currency", "Status", "Rail", "Orchestration Fee", "Latency (s)", "Settled At (EAT)", "Settled Amount", "Provider Ref"],
        all.map((x) => [
          referenceFor(x.id),
          formatEAT(x.created_at),
          merchant.business_name,
          merchant.terminal_id,
          Number(x.amount).toFixed(2),
          x.currency,
          x.status,
          x.rail,
          Number(x.fee_ft).toFixed(2),
          x.latency_ms != null ? (x.latency_ms / 1000).toFixed(2) : null,
          x.settled_at ? formatEAT(x.settled_at) : null,
          x.settled_amount != null ? Number(x.settled_amount).toFixed(2) : null,
          x.arifpay_ref,
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
  const etb = t("common.etb");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
        <div className="min-w-[16rem] flex-1 space-y-1">
          <p>{t("sales.banner")}</p>
          <p className="text-xs text-amber-300/80">{days === 1 ? t("sales.dayUntil") : t("sales.daysUntil", { n: days })}</p>
        </div>
        <button onClick={exportYear} disabled={exporting} className="ml-auto inline-flex shrink-0 items-center gap-2 rounded-xl bg-amber-400 px-4 py-2 font-semibold text-slate-950 disabled:opacity-60">
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {t("sales.export")}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <CalendarRange className="h-5 w-5 text-brand" />
        <div className="flex flex-wrap rounded-lg bg-slate-950 p-1 text-sm">
          {PRESETS.map((p) => (
            <button key={p.id} onClick={() => setPreset(p.id)} className={`rounded-md px-3 py-1.5 font-medium ${preset === p.id ? "bg-slate-700 text-white" : "text-slate-400"}`}>
              {t(p.key)}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 [color-scheme:dark]" />
            <span className="text-slate-500">{t("sales.to")}</span>
            <input type="date" value={customTo} min={customFrom} max={daysAgoKey(0)} onChange={(e) => setCustomTo(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 [color-scheme:dark]" />
          </div>
        )}
        <span className="ml-auto text-xs text-slate-500">
          {range.from} → {range.to} (EAT)
        </span>
      </div>

      {(rangeError || error) && <div className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{rangeError ?? error}</div>}
      {notice && <div className="rounded-lg bg-emerald-500/15 p-3 text-sm text-emerald-300">{notice}</div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t("sales.stat.gross")} value={`${fmt(summary.gross)} ${etb}`} />
        <Stat label={t("sales.stat.paid")} value={String(summary.paid)} />
        <Stat label={t("sales.stat.settled")} value={String(summary.settled)} />
        <Stat label={t("sales.stat.fees")} value={`${fmt(summary.fees)} ${etb}`} />
      </div>

      <section className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
            <tr>
              {[t("sales.col.time"), t("common.reference"), t("common.amount"), t("sales.col.paidWith"), t("common.status"), ""].map((h, i) => (
                <th key={i} className="px-4 py-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                  {t("sales.none")}
                </td>
              </tr>
            )}
            {!loading &&
              rows.slice(0, 100).map((x) => (
                <tr key={x.id} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-4 py-3 text-slate-400">{formatEAT(x.created_at)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-300">{referenceFor(x.id)}</td>
                  <td className="px-4 py-3 font-medium tabular-nums">
                    {fmt(Number(x.amount))} {x.currency === "ETB" ? etb : x.currency}
                  </td>
                  <td className="px-4 py-3 text-slate-300">{x.rail}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={x.status} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    {isPaid(x.status) && !openRefundIds.has(referenceFor(x.id)) && (
                      <button onClick={() => setRefundFor(x)} className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-300 hover:border-brand">
                        <RotateCcw className="h-3 w-3" /> {t("sales.refund.button")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {!loading && rows.length > 100 && (
          <div className="border-t border-slate-800 px-4 py-2 text-xs text-slate-500">
            {t("sales.showing", { n: `${rows.length}${truncated ? "+" : ""}` })}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <h3 className="mb-3 font-semibold">{t("sales.refunds.title")}</h3>
        {refunds.length === 0 ? (
          <p className="text-sm text-slate-500">{t("sales.refunds.empty")}</p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {refunds.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 py-3 text-sm">
                <div className="min-w-0">
                  <div className="font-semibold tabular-nums">
                    {fmt(Number(r.amount))} {etb} <span className="ml-2 font-mono text-xs font-normal text-slate-500">{r.reference}</span>
                  </div>
                  <div className="text-xs text-slate-400">{r.reason}</div>
                  {r.admin_note && (
                    <div className="mt-1 text-xs text-slate-300">
                      {t("sales.refunds.note")}: {r.admin_note}
                    </div>
                  )}
                </div>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${r.status === "REFUNDED" ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30" : r.status === "REJECTED" ? "bg-rose-500/15 text-rose-300 ring-rose-500/30" : "bg-amber-500/15 text-amber-300 ring-amber-500/30"}`}>
                  {t(`refund.${r.status}` as Key)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {refundFor && (
        <RefundDialog
          tx={refundFor}
          merchantId={merchant.id}
          onClose={() => setRefundFor(null)}
          onSent={() => {
            setRefundFor(null);
            setNotice(t("sales.refund.sent"));
            void loadRefunds();
          }}
        />
      )}
    </div>
  );
}

function RefundDialog({ tx, merchantId, onClose, onSent }: { tx: Transaction; merchantId: string; onClose: () => void; onSent: () => void }) {
  const t = useT();
  const [amount, setAmount] = useState(String(Number(tx.amount)));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchant_id: merchantId, transaction_id: tx.id, amount: Number(amount), reason }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t("common.errorGeneric"));
      onSent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full max-w-md space-y-4 rounded-t-3xl border border-slate-700 bg-slate-900 p-5 sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold">{t("sales.refund.title")}</h3>
        <p className="text-sm text-slate-400">{t("sales.refund.body")}</p>
        <div className="font-mono text-xs text-slate-500">{referenceFor(tx.id)}</div>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t("sales.refund.amount")}</span>
          <input type="number" min="0.01" max={Number(tx.amount)} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-lg" />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t("sales.refund.reason")}</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder={t("sales.refund.placeholder")} className="h-24 w-full resize-none rounded-xl border border-slate-700 bg-slate-950 p-3" />
        </label>
        {error && <p className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</p>}
        <div className="grid grid-cols-2 gap-2">
          <button onClick={onClose} className="h-12 rounded-xl border border-slate-600 font-semibold">
            {t("common.cancel")}
          </button>
          <button onClick={submit} disabled={busy || reason.trim().length < 3} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-brand font-bold text-slate-950 disabled:opacity-50">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("sales.refund.send")}
          </button>
        </div>
      </div>
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
