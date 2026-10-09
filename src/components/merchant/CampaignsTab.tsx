"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Megaphone } from "lucide-react";
import { fmt } from "@/lib/format";
import { AD_IMPRESSION_COST, type AdCampaign, type CampaignStatus, type Merchant, type TargetCategory } from "@/lib/types";

const EMPTY = { title: "", description: "", target_category: "ALL" as TargetCategory, image_url: "", phone_cta: "", location_cta: "", budget: "" };

const statusStyle: Record<CampaignStatus, string> = {
  ACTIVE: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  PAUSED: "bg-slate-500/15 text-slate-300 ring-slate-500/30",
  EXHAUSTED: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
};

const input = "w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm placeholder:text-slate-600 focus:border-brand focus:outline-none";

export function CampaignsTab({ merchant }: { merchant: Merchant }) {
  const [form, setForm] = useState(EMPTY);
  const [campaigns, setCampaigns] = useState<AdCampaign[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/ads/campaigns?merchant_id=${merchant.id}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load campaigns");
      setCampaigns(data);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [merchant.id]);

  useEffect(() => {
    void load();
    const id = setInterval(load, 10_000); // live delivery counters
    return () => clearInterval(id);
  }, [load]);

  const budget = Number(form.budget);
  const estImpressions = Number.isFinite(budget) && budget > 0 ? Math.floor(Math.round(budget * 100) / Math.round(AD_IMPRESSION_COST * 100)) : 0;

  const set = <K extends keyof typeof EMPTY>(k: K, v: (typeof EMPTY)[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setSaved(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/ads/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, budget, merchant_id: merchant.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not create campaign");
      setForm(EMPTY);
      setSaved(true);
      await load();
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <form onSubmit={submit} className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Megaphone className="h-5 w-5 text-brand" /> New sponsored offer
        </h2>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Title">
            <input className={input} value={form.title} maxLength={80} required onChange={(e) => set("title", e.target.value)} placeholder="20% off your first coffee" />
          </Field>
          <Field label="Target category" hint="Which merchants' receipts show this offer">
            <select className={input} value={form.target_category} onChange={(e) => set("target_category", e.target.value as TargetCategory)}>
              <option value="ALL">All merchants</option>
              <option value="Fuel">Fuel stations</option>
              <option value="Retail">Retail shops</option>
            </select>
          </Field>
          <div className="md:col-span-2">
            <Field label="Description">
              <textarea
                className={`${input} h-20 resize-none`}
                value={form.description}
                maxLength={240}
                required
                onChange={(e) => set("description", e.target.value)}
                placeholder="Show this receipt at the counter. Valid until Sunday."
              />
            </Field>
          </div>
          <Field label="Image URL" hint="Square logo, https link">
            <input className={input} type="url" value={form.image_url} onChange={(e) => set("image_url", e.target.value)} placeholder="https://…/logo.png" />
          </Field>
          <Field label="Phone CTA">
            <input className={input} type="tel" inputMode="tel" value={form.phone_cta} onChange={(e) => set("phone_cta", e.target.value)} placeholder="+251911234567" />
          </Field>
          <Field label="Location CTA" hint="Address or a Google Maps link">
            <input className={input} value={form.location_cta} maxLength={300} onChange={(e) => set("location_cta", e.target.value)} placeholder="Bole Rd, next to Edna Mall" />
          </Field>
          <Field label="Budget (ETB)">
            <input className={input} type="number" inputMode="decimal" min={5} max={100000} step="0.01" required value={form.budget} onChange={(e) => set("budget", e.target.value)} placeholder="500" />
          </Field>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand/30 bg-brand/10 p-4">
          <div>
            <div className="text-xs text-emerald-300">Live reach calculator</div>
            <div className="text-2xl font-bold tabular-nums">{estImpressions.toLocaleString("en-US")} <span className="text-base font-medium text-slate-400">estimated impressions</span></div>
            <div className="text-xs text-slate-400">
              Estimated Impressions = Budget / {AD_IMPRESSION_COST.toFixed(2)} ETB = {Number.isFinite(budget) && budget > 0 ? fmt(budget) : "0.00"} / {AD_IMPRESSION_COST.toFixed(2)}
            </div>
          </div>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-3 font-bold text-slate-950 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Launch campaign
          </button>
        </div>

        {submitError && <div className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{submitError}</div>}
        {saved && <div className="rounded-lg bg-emerald-500/15 p-3 text-sm text-emerald-300">Campaign launched. It will start appearing on receipts immediately.</div>}
      </form>

      {loadError && <div className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{loadError}</div>}

      <section className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900">
        <div className="border-b border-slate-800 px-4 py-3 text-sm font-semibold">Campaigns</div>
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-slate-800 text-xs uppercase text-slate-400">
            <tr>
              {["Campaign", "Status", "Budget Spent", "Remaining Balance", "Impressions Delivered", "Clicks"].map((h) => (
                <th key={h} className="px-4 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {campaigns.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-500">No campaigns yet.</td></tr>
            )}
            {campaigns.map((c) => {
              const spent = Math.max(0, Number(c.budget) - Number(c.remaining_budget));
              const pct = Number(c.budget) > 0 ? Math.min(100, (spent / Number(c.budget)) * 100) : 0;
              return (
                <tr key={c.id} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium">{c.title}</div>
                    <div className="text-xs text-slate-500">{c.target_category === "ALL" ? "All merchants" : c.target_category}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${statusStyle[c.status]}`}>{c.status}</span>
                  </td>
                  <td className="px-4 py-3 tabular-nums">
                    {fmt(spent)} ETB
                    <div className="mt-1 h-1 w-24 overflow-hidden rounded bg-slate-800"><div className="h-full bg-brand" style={{ width: `${pct}%` }} /></div>
                  </td>
                  <td className="px-4 py-3 tabular-nums">{fmt(Number(c.remaining_budget))} ETB</td>
                  <td className="px-4 py-3 tabular-nums">{c.impressions_count.toLocaleString("en-US")}</td>
                  <td className="px-4 py-3 tabular-nums">{c.clicks_count.toLocaleString("en-US")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-300">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}
