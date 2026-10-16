"use client";

import { useCallback, useEffect, useState } from "react";
import { Link2, Loader2, Radio, Unlink } from "lucide-react";
import { fmt } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { CaughtRide } from "@/lib/use-ride-catcher";

interface LinkRow {
  id: string;
  company: string;
  driver_ref: string;
  status: "PENDING" | "ACTIVE";
  since: string;
}

/**
 * The driver's Rides tab: whether the app is listening for finished trips, the fare waiting right now, and the ride-hailing companies
 * this driver works with (any number at once). Linking is by the code the company shows, or by accepting the company's request.
 */
export function DriverRidesTab({ ride, listening, onOpenRide }: { ride: CaughtRide | null; listening: boolean; onOpenRide: (id: string) => void }) {
  const t = useT();
  const [links, setLinks] = useState<LinkRow[] | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/driver/links", { cache: "no-store" });
      if (res.ok) setLinks(await res.json());
    } catch {
      /* shown as empty; retried on the next visit */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const redeem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/driver/links/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        setMsg({ ok: true, text: t("driver.linked", { name: d.company ?? "" }) });
        setCode("");
        await load();
      } else setMsg({ ok: false, text: d.error ?? t("common.errorGeneric") });
    } catch {
      setMsg({ ok: false, text: t("common.offline") });
    } finally {
      setBusy(false);
    }
  };

  const answer = async (id: string, action: "confirm" | "decline") => {
    await fetch(`/api/driver/links/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }).catch(() => {});
    await load();
  };
  const unlink = async (id: string) => {
    if (!window.confirm(t("driver.unlinkConfirm"))) return;
    await fetch(`/api/driver/links/${id}`, { method: "DELETE" }).catch(() => {});
    await load();
  };

  const pending = (links ?? []).filter((l) => l.status === "PENDING");
  const active = (links ?? []).filter((l) => l.status === "ACTIVE");

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Radio className={listening ? "h-5 w-5 text-emerald-400" : "h-5 w-5 text-slate-500"} /> {t("driver.rides.title")}
        </h2>
        {ride ? (
          <div className="mt-3 rounded-xl border border-brand/40 bg-brand/10 p-4">
            <div className="text-sm text-slate-300">{t("driver.rides.waiting", { company: ride.company })}</div>
            <div className="mt-1 text-4xl font-bold tabular-nums">
              {fmt(ride.amount)} <span className="text-lg text-slate-400">{ride.currency === "ETB" ? t("common.etb") : ride.currency}</span>
            </div>
            <button onClick={() => onOpenRide(ride.id)} className="mt-3 w-full rounded-xl bg-brand px-4 py-3 font-bold text-slate-950">
              {t("driver.rides.open")}
            </button>
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-400">{listening ? t("driver.rides.listening") : t("driver.rides.idle")}</p>
        )}
        <p className="mt-3 text-xs text-slate-500">{t("driver.rides.openNote")}</p>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Link2 className="h-5 w-5 text-brand" /> {t("driver.link.title")}
        </h2>
        <p className="mt-1 text-sm text-slate-400">{t("driver.link.body")}</p>
        <form onSubmit={redeem} className="mt-3 flex gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCD-EFGH"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={9}
            aria-label={t("driver.link.code")}
            className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono tracking-widest"
          />
          <button disabled={busy || code.replace(/[^A-Za-z0-9]/g, "").length < 8} className="rounded-lg bg-brand px-4 py-2 font-semibold text-slate-950 disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t("driver.link.cta")}
          </button>
        </form>
        {msg && <p className={msg.ok ? "mt-2 text-sm text-emerald-300" : "mt-2 text-sm text-rose-300"}>{msg.text}</p>}
      </section>

      {pending.length > 0 && (
        <section className="space-y-2 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-5">
          <h3 className="font-semibold">{t("driver.pending.title")}</h3>
          {pending.map((l) => (
            <div key={l.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-900/60 p-3">
              <div className="min-w-[10rem] flex-1">
                <div className="font-medium">{l.company}</div>
                <div className="text-xs text-slate-400">{t("driver.pending.id", { id: l.driver_ref })}</div>
              </div>
              <button onClick={() => answer(l.id, "confirm")} className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-slate-950">
                {t("driver.pending.accept")}
              </button>
              <button onClick={() => answer(l.id, "decline")} className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm">
                {t("driver.pending.decline")}
              </button>
            </div>
          ))}
        </section>
      )}

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h3 className="font-semibold">{t("driver.companies.title")}</h3>
        {links === null ? (
          <p className="mt-2 text-sm text-slate-500">{t("common.loading")}</p>
        ) : active.length === 0 ? (
          <p className="mt-2 text-sm text-slate-400">{t("driver.companies.none")}</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-800">
            {active.map((l) => (
              <li key={l.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{l.company}</div>
                  <div className="text-xs text-slate-400">{t("driver.pending.id", { id: l.driver_ref })}</div>
                </div>
                <button onClick={() => unlink(l.id)} className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-rose-300">
                  <Unlink className="h-4 w-4" /> {t("driver.companies.unlink")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
