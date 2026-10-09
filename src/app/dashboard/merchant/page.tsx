"use client";

import { useEffect, useState } from "react";
import { BarChart3, CalendarClock, Megaphone, Nfc, Zap } from "lucide-react";
import type { Merchant } from "@/lib/types";
import { TerminalPanel } from "@/components/TerminalPanel";
import { LookbackTab } from "@/components/merchant/LookbackTab";
import { BriefingTab } from "@/components/merchant/BriefingTab";
import { CampaignsTab } from "@/components/merchant/CampaignsTab";

const TABS = [
  { id: "terminal", label: "Terminal", icon: Nfc },
  { id: "lookback", label: "Lookback & Export", icon: CalendarClock },
  { id: "briefing", label: "Daily Briefing", icon: BarChart3 },
  { id: "ads", label: "Ad Campaigns", icon: Megaphone },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function MerchantPortalPage() {
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [merchantId, setMerchantId] = useState("");
  const [tab, setTab] = useState<TabId>("terminal");
  const [saleActive, setSaleActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/merchants")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d) && d.length) {
          setMerchants(d);
          setMerchantId(d[0].id);
        } else setError(d?.error ?? "No merchants found");
      })
      .catch(() => setError("Cannot reach API"));
  }, []);

  const merchant = merchants.find((m) => m.id === merchantId);

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-brand">
          <Zap className="h-5 w-5" /> <h1 className="text-xl font-bold text-white">2Pay Merchant Portal</h1>
        </div>
        <select
          value={merchantId}
          onChange={(e) => setMerchantId(e.target.value)}
          disabled={saleActive}
          aria-label="Merchant"
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm disabled:opacity-50"
        >
          {merchants.map((m) => (
            <option key={m.id} value={m.id}>
              {m.business_name} · {m.terminal_id}
            </option>
          ))}
        </select>
      </header>

      <nav className="mb-6 flex gap-1 overflow-x-auto rounded-xl bg-slate-900 p-1 text-sm" role="tablist">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`flex shrink-0 items-center gap-2 rounded-lg px-4 py-2 font-medium ${tab === id ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200"}`}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </nav>

      {error && <div className="mb-4 rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</div>}

      {merchant && (
        <>
          {/* Terminal stays mounted so an in-flight sale survives tab switches. */}
          <div hidden={tab !== "terminal"}>
            <TerminalPanel key={merchant.id} merchantId={merchant.id} merchantName={merchant.business_name} category={merchant.category} onActiveChange={setSaleActive} />
          </div>
          {tab === "lookback" && <LookbackTab key={merchant.id} merchant={merchant} />}
          {tab === "briefing" && <BriefingTab key={merchant.id} merchant={merchant} />}
          {tab === "ads" && <CampaignsTab key={merchant.id} merchant={merchant} />}
        </>
      )}
    </main>
  );
}
