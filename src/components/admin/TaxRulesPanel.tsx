"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
import { formatEAT } from "@/lib/format";
import { CATEGORY_LABEL, type Category } from "@/lib/categories";
import type { TaxRules } from "@/lib/tax";
import { cn } from "@/lib/utils";

interface Stored {
  rules: TaxRules;
  version: number;
  confirmed_by: string | null;
  confirmed_at: string | null;
  updated_at: string | null;
}

const CATS: Category[] = ["Fuel", "Supermarket", "Retail", "Service", "Ride", "Merchant"];
const pctText = (r: number) => String(Math.round(r * 10000) / 100);
const fromPct = (s: string) => Number(s) / 100;

/**
 * The rules behind merchants' tax estimates. Saving makes a NEW, unconfirmed version; once a tax adviser has checked the figures against current
 * law, an administrator confirms that exact version with their name. Merchants see a warning until the current version is confirmed.
 */
export function TaxRulesPanel() {
  const [data, setData] = useState<Stored | null>(null);
  const [vat, setVat] = useState("");
  const [threshold, setThreshold] = useState("");
  const [inclusive, setInclusive] = useState(true);
  const [tot, setTot] = useState("");
  const [cats, setCats] = useState<Record<string, string>>({});
  const [who, setWho] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/tax-rules", { cache: "no-store" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Could not load");
      setData(d);
      setVat(pctText(d.rules.vat.rate));
      setThreshold(String(d.rules.vat.threshold));
      setInclusive(d.rules.vat.inclusive);
      setTot(pctText(d.rules.turnover.rate));
      setCats(Object.fromEntries(CATS.map((c) => [c, pctText(d.rules.turnover.byCategory[c] ?? d.rules.turnover.rate)])));
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const send = async (method: "PUT" | "POST", body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/tax-rules", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Failed");
      setMsg({ ok: true, text: done });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!data) return msg ? <p className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{msg.text}</p> : <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-500" />;

  const save = () =>
    send(
      "PUT",
      { rules: { vat: { rate: fromPct(vat), threshold: Number(threshold), inclusive }, turnover: { rate: fromPct(tot), byCategory: Object.fromEntries(CATS.map((c) => [c, fromPct(cats[c] ?? tot)])) } } },
      "Saved as a new version. It is unconfirmed until you confirm it below.",
    );
  const confirmed = !!data.confirmed_at;
  const input = "h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm";

  return (
    <div className="space-y-4">
      {msg && <p className={cn("rounded-lg p-3 text-sm", msg.ok ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300")}>{msg.text}</p>}
      <div className={cn("flex items-start gap-2 rounded-xl border p-3 text-sm", confirmed ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-amber-500/40 bg-amber-500/10 text-amber-200")}>
        {confirmed ? <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /> : <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />}
        <span>
          {confirmed ? `Version ${data.version} was confirmed by ${data.confirmed_by} on ${formatEAT(data.confirmed_at!)}.` : `Version ${data.version} is NOT confirmed. Merchants see a warning that these rates are unchecked. The built-in defaults are the long-standing rates; Ethiopian tax law has been changing, so have a tax adviser check them against current law before confirming.`}
        </span>
      </div>

      <div className="grid gap-3 rounded-xl border border-slate-800 bg-slate-950 p-3 md:grid-cols-3">
        <label className="text-xs text-slate-400">
          VAT rate (%)
          <input value={vat} onChange={(e) => setVat(e.target.value)} inputMode="decimal" className={input} />
        </label>
        <label className="text-xs text-slate-400">
          VAT threshold: yearly takings in birr
          <input value={threshold} onChange={(e) => setThreshold(e.target.value)} inputMode="numeric" className={input} />
        </label>
        <label className="flex items-end gap-2 pb-2 text-xs text-slate-400">
          <input type="checkbox" checked={inclusive} onChange={(e) => setInclusive(e.target.checked)} className="h-4 w-4" /> Prices already include VAT
        </label>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
        <div className="mb-2 text-sm font-semibold">Turnover tax (businesses under the VAT threshold)</div>
        <div className="grid gap-3 md:grid-cols-4">
          <label className="text-xs text-slate-400">
            Default rate (%)
            <input value={tot} onChange={(e) => setTot(e.target.value)} inputMode="decimal" className={input} />
          </label>
          {CATS.map((c) => (
            <label key={c} className="text-xs text-slate-400">
              {CATEGORY_LABEL[c]} (%)
              <input value={cats[c] ?? ""} onChange={(e) => setCats((p) => ({ ...p, [c]: e.target.value }))} inputMode="decimal" className={input} />
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <button disabled={busy} onClick={save} className="h-10 rounded-lg bg-brand px-4 text-sm font-bold text-slate-950 disabled:opacity-50">
          Save as new version
        </button>
        {!confirmed && (
          <>
            <label className="min-w-[12rem] flex-1 text-xs text-slate-400">
              Confirmed by (name of the person who checked)
              <input value={who} onChange={(e) => setWho(e.target.value)} maxLength={80} className={input} />
            </label>
            <button disabled={busy || who.trim().length < 2} onClick={() => send("POST", { confirm: true, version: data.version, name: who }, "Confirmed.")} className="h-10 rounded-lg bg-emerald-600 px-4 text-sm font-bold text-white disabled:opacity-40">
              Confirm version {data.version}
            </button>
          </>
        )}
      </div>
      <p className="text-xs text-slate-500">Saving changes the figures merchants see straight away and removes the confirmation. Nothing is sent to the tax authority: these are estimates for the merchant&apos;s own planning.</p>
    </div>
  );
}
