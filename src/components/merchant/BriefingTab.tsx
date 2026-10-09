"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Banknote, CheckCircle2, Clock, ShieldAlert } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { eatDateKey, eatDayEndISO, eatDayStartISO, fmt } from "@/lib/format";
import { fetchTransactions } from "@/lib/tx-query";
import { isPaid, type Merchant, type Transaction } from "@/lib/types";

/** A paid tap not confirmed by Arifpay within this window counts as unreconciled. */
const RECONCILE_GRACE_MS = 10 * 60_000;

type Recon = { kind: "ok" } | { kind: "pending"; count: number } | { kind: "mismatch"; count: number };

export function BriefingTab({ merchant }: { merchant: Merchant }) {
  const [rows, setRows] = useState<Transaction[]>([]);
  const [mismatches, setMismatches] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const day = eatDateKey(new Date());
    const from = eatDayStartISO(day);
    try {
      const [tx, ev] = await Promise.all([
        fetchTransactions(merchant.id, from, eatDayEndISO(day)),
        supabase
          .from("watchdog_events")
          .select("id", { count: "exact", head: true })
          .eq("merchant_id", merchant.id)
          .eq("event_type", "SETTLEMENT_MISMATCH")
          .gte("created_at", from),
      ]);
      setRows(tx.rows);
      setMismatches(ev.count ?? 0);
      setNow(Date.now());
      setError(ev.error ? "Mismatch alerts unavailable — reconciliation status may be incomplete." : null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [merchant.id]);

  useEffect(() => {
    void load();
    const channel = supabase
      .channel(`briefing-${merchant.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "transactions", filter: `merchant_id=eq.${merchant.id}` }, () => void load())
      .subscribe();
    const poll = setInterval(load, 15_000);
    return () => {
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [load, merchant.id]);

  const brief = useMemo(() => {
    const paid = rows.filter((r) => isPaid(r.status));
    const settledMs = rows
      .filter((r) => r.status === "SETTLED" && r.settled_at)
      .map((r) => new Date(r.settled_at!).getTime() - new Date(r.created_at).getTime())
      .filter((ms) => ms >= 0);
    const authMs = paid.map((r) => r.latency_ms).filter((l): l is number => l != null);
    // Prefer true end-to-end settlement time; fall back to authorization latency until Arifpay confirms.
    const sample = settledMs.length ? settledMs : authMs;
    const stale = paid.filter((r) => r.status === "SUCCESS" && now - new Date(r.created_at).getTime() > RECONCILE_GRACE_MS).length;
    const recon: Recon = mismatches > 0 ? { kind: "mismatch", count: mismatches } : stale > 0 ? { kind: "pending", count: stale } : { kind: "ok" };
    return {
      gross: paid.reduce((s, r) => s + Number(r.amount), 0),
      count: paid.length,
      avgSeconds: sample.length ? sample.reduce((a, b) => a + b, 0) / sample.length / 1000 : null,
      basis: settledMs.length ? "settled" : "authorized",
      recon,
    };
  }, [rows, mismatches, now]);

  const reconView = {
    ok: { en: "Reconciled", am: "ተታርቋል", cls: "text-emerald-400", Icon: CheckCircle2 },
    pending: { en: `${(brief.recon as { count?: number }).count ?? 0} awaiting settlement`, am: "ማረጋገጫ በመጠባበቅ ላይ", cls: "text-amber-400", Icon: Clock },
    mismatch: { en: `${(brief.recon as { count?: number }).count ?? 0} mismatch flagged`, am: "ልዩነት ተገኝቷል", cls: "text-rose-400", Icon: ShieldAlert },
  }[brief.recon.kind];

  const today = new Date().toLocaleDateString("en-GB", { timeZone: "Africa/Addis_Ababa", weekday: "long", day: "numeric", month: "long", year: "numeric" });

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">
          Daily Business Briefing <span className="text-slate-400">· የዕለቱ የንግድ ማጠቃለያ</span>
        </h2>
        <span className="text-xs text-slate-500">{today} · {merchant.business_name}</span>
      </div>

      {error && <div className="mb-4 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-300">{error}</div>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile icon={<Banknote className="h-4 w-4 text-brand" />} en="Gross takings" am="ጠቅላላ ገቢ" value={`${fmt(brief.gross)} ETB`} />
        <Tile icon={<Activity className="h-4 w-4 text-brand" />} en="Transactions" am="ግብይቶች" value={String(brief.count)} />
        <Tile
          icon={<Clock className="h-4 w-4 text-brand" />}
          en="Avg settlement time"
          am="አማካይ የክፍያ ጊዜ"
          value={brief.avgSeconds == null ? "—" : `${brief.avgSeconds.toFixed(1)}s`}
          sub={brief.avgSeconds == null ? undefined : brief.basis === "settled" ? "tap → Arifpay settled" : "tap → authorized"}
        />
        <Tile
          icon={<reconView.Icon className={`h-4 w-4 ${reconView.cls}`} />}
          en="Reconciliation"
          am="ማስታረቅ"
          value={reconView.en}
          valueClass={reconView.cls}
          sub={reconView.am}
        />
      </div>
    </section>
  );
}

function Tile({
  icon,
  en,
  am,
  value,
  sub,
  valueClass = "",
}: {
  icon: React.ReactNode;
  en: string;
  am: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>
          {en} <span className="text-slate-500">· {am}</span>
        </span>
        {icon}
      </div>
      <div className={`mt-2 text-2xl font-bold tabular-nums ${valueClass}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}
