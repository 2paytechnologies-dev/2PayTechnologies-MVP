"use client";

import { useEffect, useState } from "react";
import { HandCoins, Loader2, Users } from "lucide-react";
import { useT } from "@/lib/i18n";
import { eatDateKey, eatDayStartISO, fmt } from "@/lib/format";
import { pollWhileVisible } from "@/lib/poll";
import type { LedgerLine } from "@/lib/team";

interface Ledger {
  lines: LedgerLine[];
  totals: { sales: number; revenue: number; tips: number; total: number };
}

/**
 * Today's ledger by team member: sales (what was keyed), tips (what customers paid on top) and the total, per person.
 * The owner and the cashier see everyone; a waiter's server answer contains only their own line ("My shift today").
 * Refreshes by itself, so a new payment shows up within seconds.
 */
export function ShiftLedger({ merchantId, mine = false }: { merchantId: string; mine?: boolean }) {
  const t = useT();
  const [data, setData] = useState<Ledger | null>(null);
  const [failed, setFailed] = useState(false);
  const etb = t("common.etb");

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const from = eatDayStartISO(eatDateKey(new Date()));
        const to = new Date(Date.now() + 86_400_000).toISOString();
        const res = await fetch(`/api/team/ledger?${new URLSearchParams({ merchant_id: merchantId, from, to })}`, { cache: "no-store" });
        if (!res.ok || stopped) {
          if (!stopped) setFailed(true);
          return;
        }
        setData((await res.json()) as Ledger);
        setFailed(false);
      } catch {
        if (!stopped) setFailed(true);
      }
    };
    // One request at a time, paused while the app is in the background, caught up when it comes back.
    const stop = pollWhileVisible(load, 10_000);
    return () => {
      stopped = true;
      stop();
    };
  }, [merchantId]);

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-300">
        {mine ? <HandCoins className="h-4 w-4 text-brand" /> : <Users className="h-4 w-4 text-brand" />} {t(mine ? "crew.ledger.mine" : "crew.ledger.title")}
      </h3>

      {!data && !failed && <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-500" />}
      {failed && !data && <p className="text-sm text-slate-500">{t("common.errorGeneric")}</p>}

      {data && (
        <>
          <div className="mb-3 grid grid-cols-3 gap-2 text-center">
            <Stat label={t("crew.ledger.revenue")} value={`${fmt(data.totals.revenue)}`} />
            <Stat label={t("crew.ledger.tips")} value={`${fmt(data.totals.tips)}`} tone="amber" />
            <Stat label={t("crew.ledger.total")} value={`${fmt(data.totals.total)}`} tone="brand" />
          </div>

          {data.lines.length === 0 ? (
            <p className="text-sm text-slate-500">{t("crew.ledger.empty")}</p>
          ) : (
            <ul className="divide-y divide-slate-800">
              {data.lines.map((l) => (
                <li key={l.staff_id ?? "counter"} className="py-2.5 text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0 truncate font-medium">
                      {l.staff_id ? l.name : t("crew.counter")}
                      {l.team_no && <span className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">{l.team_no}</span>}
                    </div>
                    <div className="shrink-0 font-bold tabular-nums">
                      {fmt(l.total)} {etb}
                    </div>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-slate-500">
                    <span>{t("crew.ledger.sales", { n: l.sales })}</span>
                    <span>
                      {t("crew.ledger.revenue")} {fmt(l.revenue)}
                    </span>
                    <span className={l.tips > 0 ? "font-semibold text-amber-300" : ""}>
                      {t("crew.ledger.tips")} {fmt(l.tips)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-600">{t("crew.ledger.note")}</p>
        </>
      )}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "amber" | "brand" }) {
  return (
    <div className="rounded-xl bg-slate-950 px-2 py-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${tone === "amber" ? "text-amber-300" : tone === "brand" ? "text-brand" : "text-white"}`}>{value}</div>
    </div>
  );
}
