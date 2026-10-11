"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Loader2, Route, TriangleAlert } from "lucide-react";
import { Logo } from "@/components/Logo";
import { defaultMerchantId } from "@/lib/client-session";
import { AccountSection, type AccountRow } from "@/components/settings/AccountSection";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MAX_SAVED, type SettlementKind } from "@/lib/constants";
import { maskAccount, normalizeAccount, type SettlementView } from "@/lib/settlement";
import type { Merchant } from "@/lib/types";

/** A row the merchant added in this session; its full number is sent once on save and never shown again. */
interface Draft extends AccountRow {
  accountNumber?: string;
}

const fromView = (list: SettlementView["saved_banks"]): Draft[] => list.map((a) => ({ id: a.id, institution: a.institution, masked: a.account_masked }));

export default function SettlementSettingsPage() {
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [merchantId, setMerchantId] = useState("");
  const [banks, setBanks] = useState<Draft[]>([]);
  const [wallets, setWallets] = useState<Draft[]>([]);
  const [activeBank, setActiveBank] = useState<string | null>(null);
  const [activeWallet, setActiveWallet] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // The form is only shown once the saved settings loaded: saving an empty form after a failed load would wipe them.
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/merchants")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d) && d.length) {
          setMerchants(d);
          void defaultMerchantId(d).then(setMerchantId);
        } else setError(d?.error ?? "No merchants found");
      })
      .catch(() => setError("Cannot reach API"));
  }, []);

  const apply = useCallback((v: SettlementView) => {
    setBanks(fromView(v.saved_banks));
    setWallets(fromView(v.saved_wallets));
    setActiveBank(v.active_bank_id);
    setActiveWallet(v.active_wallet_id);
    setDirty(false);
  }, []);

  useEffect(() => {
    if (!merchantId) return;
    let cancelled = false;
    setLoading(true);
    setLoaded(false);
    setError(null);
    setSaved(false);
    fetch(`/api/merchants/${merchantId}/settlement`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "Could not load settings");
        if (!cancelled) {
          apply(d);
          setLoaded(true);
        }
      })
      .catch((e) => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [merchantId, apply]);

  const edit = (kind: SettlementKind) => ({
    rows: kind === "bank" ? banks : wallets,
    set: kind === "bank" ? setBanks : setWallets,
    activeId: kind === "bank" ? activeBank : activeWallet,
    setActive: kind === "bank" ? setActiveBank : setActiveWallet,
  });

  const add = (kind: SettlementKind) => (institution: string, raw: string): string | null => {
    const { rows, set, activeId, setActive } = edit(kind);
    if (rows.length >= MAX_SAVED) return `You can save at most ${MAX_SAVED}.`;
    if (!institution) return `Choose a ${kind} first.`;
    const normalized = normalizeAccount(kind, raw);
    if (!normalized) return kind === "bank" ? "Account number must be 6–20 digits." : "Enter a valid Ethiopian mobile number, e.g. 0911223344.";
    const masked = maskAccount(normalized);
    if (rows.some((r) => r.institution === institution && r.masked === masked)) return "That account is already saved.";
    const id = crypto.randomUUID();
    set([...rows, { id, institution, masked, accountNumber: raw }]);
    if (!activeId) setActive(id); // first account becomes active automatically
    setDirty(true);
    setSaved(false);
    return null;
  };

  const remove = (kind: SettlementKind) => (id: string) => {
    const { rows, set, activeId, setActive } = edit(kind);
    const next = rows.filter((r) => r.id !== id);
    set(next);
    if (activeId === id) setActive(next[0]?.id ?? null);
    setDirty(true);
    setSaved(false);
  };

  const activate = (kind: SettlementKind) => (id: string) => {
    edit(kind).setActive(id);
    setDirty(true);
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    const entries = (rows: Draft[]) => rows.map((r) => (r.accountNumber ? { id: r.id, institution: r.institution, account_number: r.accountNumber } : { id: r.id }));
    try {
      const res = await fetch(`/api/merchants/${merchantId}/settlement`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ banks: entries(banks), wallets: entries(wallets), active_bank_id: activeBank, active_wallet_id: activeWallet }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Could not save");
      apply(d);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const bankName = banks.find((b) => b.id === activeBank)?.institution;
  const walletName = wallets.find((w) => w.id === activeWallet)?.institution;
  const routing = [bankName, walletName].filter(Boolean).join(" • ");

  return (
    <main className="mx-auto max-w-3xl space-y-5 p-4 sm:p-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-brand">
          <Logo /> <h1 className="text-xl font-bold text-white">Settlement Routing</h1>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/dashboard/merchant" className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-slate-200">
            <ArrowLeft className="h-4 w-4" /> Merchant portal
          </Link>
          <Select value={merchantId} onValueChange={setMerchantId} disabled={saving || dirty}>
            <SelectTrigger className="w-64" aria-label="Merchant">
              <SelectValue placeholder="Merchant" />
            </SelectTrigger>
            <SelectContent>
              {merchants.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.business_name} · {m.terminal_id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      <p className="text-sm text-slate-400">
        Save up to {MAX_SAVED} bank accounts and {MAX_SAVED} wallets, then pick the one bank and one wallet that receive customer payments. Customers will be offered exactly
        these two options at checkout.
      </p>

      {error && (
        <div className="flex items-start gap-2 rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16 text-slate-500">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : !loaded ? null : (
        <>
          <AccountSection kind="bank" rows={banks} activeId={activeBank} onAdd={add("bank")} onRemove={remove("bank")} onActivate={activate("bank")} />
          <AccountSection kind="wallet" rows={wallets} activeId={activeWallet} onAdd={add("wallet")} onRemove={remove("wallet")} onActivate={activate("wallet")} />

          <div className="sticky bottom-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/95 p-4 backdrop-blur">
            <div className="flex items-center gap-2 text-sm">
              <Route className="h-4 w-4 text-brand" />
              <span className="text-slate-400">Routing to:</span>
              <span className="font-semibold">{routing || "nothing configured"}</span>
            </div>
            <div className="flex items-center gap-3">
              {saved && !dirty && (
                <span className="flex items-center gap-1 text-sm text-emerald-400">
                  <Check className="h-4 w-4" /> Saved
                </span>
              )}
              <Button onClick={save} disabled={saving || !dirty || !merchantId}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save routing preferences
              </Button>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
