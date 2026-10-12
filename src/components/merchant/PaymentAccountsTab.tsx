"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { Check, CheckCircle2, Copy, Landmark, Loader2, Nfc, Plus, Printer, Search, Smartphone, Store, Trash2, X } from "lucide-react";
import { BANKS, MAX_SAVED, POPULAR_BANKS, POPULAR_WALLETS, WALLETS, type SettlementKind } from "@/lib/constants";
import { maskAccount, normalizeAccount, type MaskedAccount, type SettlementView } from "@/lib/settlement";
import { activateAccount, addAccount, loadSettlement, removeAccount } from "@/lib/settlement-client";
import { useT } from "@/lib/i18n";
import { InstitutionBadge } from "@/components/InstitutionBadge";
import type { Merchant } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  merchant: Merchant;
  /** First visit after registering: show the welcome line. */
  welcome?: boolean;
  /** Tell the portal the routing changed so its "finish setup" banner updates. */
  onChanged: () => void;
  onOpenTerminal: () => void;
}

export function PaymentAccountsTab({ merchant, welcome, onChanged, onOpenTerminal }: Props) {
  const t = useT();
  const [view, setView] = useState<SettlementView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // which action is in flight
  const [picker, setPicker] = useState<SettlementKind | null>(null);
  const [removing, setRemoving] = useState<{ kind: SettlementKind; account: MaskedAccount } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setView(await loadSettlement(merchant.id));
      setError(null);
    } catch {
      setError(t("accounts.error.load"));
    }
  }, [merchant.id, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Runs a change and saves it at once. Returns the error text (also shown on the page), or null on success. */
  const apply = async (key: string, action: () => Promise<SettlementView>): Promise<string | null> => {
    setBusy(key);
    setError(null);
    try {
      setView(await action());
      onChanged();
      return null;
    } catch (e) {
      const msg = (e as Error).message === "load" || (e as Error).message === "save" ? t("common.errorGeneric") : (e as Error).message;
      setError(msg);
      return msg;
    } finally {
      setBusy(null);
    }
  };

  const activeBank = view?.saved_banks.find((a) => a.id === view.active_bank_id);
  const activeWallet = view?.saved_wallets.find((a) => a.id === view.active_wallet_id);
  const ready = !!(activeBank || activeWallet);

  return (
    <div className="space-y-5">
      {welcome && !ready && <div className="rounded-2xl border border-brand/40 bg-brand/10 p-4 text-sm text-emerald-100">{t("accounts.welcome")}</div>}

      <header>
        <h2 className="text-xl font-bold">{t("accounts.title")}</h2>
        <p className="text-sm text-slate-400">{t("accounts.subtitle")}</p>
      </header>

      {/* Where am I? A status card with the three steps, so nobody has to guess what to do next. */}
      <section className={cn("rounded-2xl border p-4", ready ? "border-emerald-500/40 bg-emerald-500/10" : "border-amber-500/40 bg-amber-500/10")}>
        <div className="flex items-start gap-3">
          {ready ? <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-emerald-400" /> : <Store className="mt-0.5 h-6 w-6 shrink-0 text-amber-400" />}
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold">{ready ? t("accounts.ready.title") : t("accounts.notready.title")}</h3>
            <p className="text-sm text-slate-300">{ready ? t("accounts.ready.body") : t("accounts.notready.body")}</p>
          </div>
        </div>
        <ol className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
          {[
            { n: 1, label: t("accounts.step1"), done: !!view && view.saved_banks.length + view.saved_wallets.length > 0 },
            { n: 2, label: t("accounts.step2"), done: ready },
            { n: 3, label: t("accounts.step3"), done: false },
          ].map((s) => (
            <li key={s.n} className="flex items-center gap-2">
              <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold", s.done ? "bg-emerald-500 text-slate-950" : "bg-slate-700 text-slate-200")}>
                {s.done ? <Check className="h-3.5 w-3.5" /> : s.n}
              </span>
              <span className={s.done ? "text-slate-300" : "text-slate-200"}>{s.label}</span>
            </li>
          ))}
        </ol>
        {ready && (
          <button onClick={onOpenTerminal} className="mt-3 inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-bold text-slate-950">
            <Nfc className="h-4 w-4" /> {t("accounts.openTerminal")}
          </button>
        )}
      </section>

      {error && <div className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</div>}
      {!view && !error && (
        <div className="flex justify-center py-10 text-slate-500">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      )}

      {view && (
        <>
          <AccountGroup
            kind="bank"
            accounts={view.saved_banks}
            activeId={view.active_bank_id}
            busy={busy}
            onAdd={() => setPicker("bank")}
            onActivate={(id) => apply(`on:${id}`, () => activateAccount(merchant.id, view, "bank", id))}
            onRemove={(a) => setRemoving({ kind: "bank", account: a })}
          />
          <AccountGroup
            kind="wallet"
            accounts={view.saved_wallets}
            activeId={view.active_wallet_id}
            busy={busy}
            onAdd={() => setPicker("wallet")}
            onActivate={(id) => apply(`on:${id}`, () => activateAccount(merchant.id, view, "wallet", id))}
            onRemove={(a) => setRemoving({ kind: "wallet", account: a })}
          />

          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-300">{t("accounts.preview.title")}</h3>
            {ready ? (
              <div className="mx-auto max-w-xs space-y-2">
                {activeBank && <PreviewButton kind="bank" name={activeBank.institution} label={t("accounts.preview.pay", { name: activeBank.institution })} />}
                {activeWallet && <PreviewButton kind="wallet" name={activeWallet.institution} label={t("accounts.preview.pay", { name: activeWallet.institution })} />}
              </div>
            ) : (
              <p className="text-sm text-slate-500">{t("accounts.preview.empty")}</p>
            )}
          </section>

          <ShopQr merchant={merchant} ready={ready} />
        </>
      )}

      {picker && view && (
        <Picker
          kind={picker}
          existing={picker === "bank" ? view.saved_banks : view.saved_wallets}
          hasActive={picker === "bank" ? !!view.active_bank_id : !!view.active_wallet_id}
          onClose={() => setPicker(null)}
          onSave={async (institution, number, makeActive) => {
            const err = await apply("add", () => addAccount(merchant.id, view, picker, institution, number, makeActive));
            if (!err) setPicker(null);
            return err;
          }}
        />
      )}

      {removing && view && (
        <Confirm
          title={t("accounts.removeConfirm", { name: removing.account.institution, number: removing.account.account_masked })}
          body={t("accounts.removeBody")}
          confirmLabel={t("common.remove")}
          cancelLabel={t("common.cancel")}
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            const r = removing;
            setRemoving(null);
            await apply(`rm:${r.account.id}`, () => removeAccount(merchant.id, view, r.kind, r.account.id));
          }}
        />
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------------------------- one kind of account */

function AccountGroup({
  kind,
  accounts,
  activeId,
  busy,
  onAdd,
  onActivate,
  onRemove,
}: {
  kind: SettlementKind;
  accounts: MaskedAccount[];
  activeId: string | null;
  busy: string | null;
  onAdd: () => void;
  onActivate: (id: string) => void;
  onRemove: (a: MaskedAccount) => void;
}) {
  const t = useT();
  const Icon = kind === "bank" ? Landmark : Smartphone;
  const full = accounts.length >= MAX_SAVED;
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <div className="mb-3 flex items-start gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-800">
          <Icon className="h-5 w-5 text-brand" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{kind === "bank" ? t("accounts.banks") : t("accounts.wallets")}</h3>
          <p className="text-xs text-slate-400">{kind === "bank" ? t("accounts.banksHint") : t("accounts.walletsHint")}</p>
        </div>
        <span className="text-xs text-slate-500">
          {accounts.length}/{MAX_SAVED}
        </span>
      </div>

      <ul className="space-y-2">
        {accounts.map((a) => {
          const active = a.id === activeId;
          const working = busy === `on:${a.id}` || busy === `rm:${a.id}`;
          return (
            <li key={a.id} className={cn("rounded-xl border p-3", active ? "border-emerald-500/50 bg-emerald-500/10" : "border-slate-800 bg-slate-950")}>
              {/* The name always gets a full line; the status and actions sit below it, so it is never squeezed on a phone. */}
              <div className="flex items-center gap-3">
                <InstitutionBadge name={a.institution} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium leading-snug">{a.institution}</div>
                  <div className="font-mono text-xs text-slate-400">{a.account_masked}</div>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between gap-2">
                {working ? (
                  <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
                ) : active ? (
                  <span className="flex items-center gap-1 rounded-full bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-300">
                    <Check className="h-3.5 w-3.5" /> {t("accounts.receiving")}
                  </span>
                ) : (
                  <button onClick={() => onActivate(a.id)} className="rounded-full border border-slate-600 px-4 py-1.5 text-xs font-semibold text-slate-200 hover:border-brand">
                    {t("accounts.useThis")}
                  </button>
                )}
                <button onClick={() => onRemove(a)} disabled={working} aria-label={`${t("common.remove")} ${a.institution}`} className="rounded-lg p-2 text-rose-300 hover:bg-rose-500/10 disabled:opacity-40">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </li>          );
        })}
      </ul>

      <button
        onClick={onAdd}
        disabled={full}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-700 py-3.5 font-semibold text-slate-200 transition hover:border-brand hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus className="h-5 w-5" /> {kind === "bank" ? t("accounts.addBank") : t("accounts.addWallet")}
      </button>
      {full && <p className="mt-2 text-center text-xs text-slate-500">{t("accounts.limit", { max: MAX_SAVED })}</p>}
    </section>
  );
}

function PreviewButton({ kind, name, label }: { kind: SettlementKind; name: string; label: string }) {
  return (
    <div className={cn("flex items-center gap-3 rounded-xl border p-3", kind === "bank" ? "border-sky-500/40 bg-sky-500/10" : "border-amber-500/40 bg-amber-500/10")}>
      <InstitutionBadge name={name} className="h-9 w-9 text-xs" />
      <span className="font-semibold text-white">{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- the add-an-account flow */

function Picker({
  kind,
  existing,
  hasActive,
  onClose,
  onSave,
}: {
  kind: SettlementKind;
  existing: MaskedAccount[];
  hasActive: boolean;
  onClose: () => void;
  /** Resolves to an error message to show in the dialog, or null when saved. */
  onSave: (institution: string, accountNumber: string, makeActive: boolean) => Promise<string | null>;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [number, setNumber] = useState("");
  const [makeActive, setMakeActive] = useState(!hasActive);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const all = kind === "bank" ? (BANKS as readonly string[]) : (WALLETS as readonly string[]);
  const popular = kind === "bank" ? (POPULAR_BANKS as readonly string[]) : (POPULAR_WALLETS as readonly string[]);
  const matches = useMemo(() => all.filter((n) => n.toLowerCase().includes(query.trim().toLowerCase())), [all, query]);

  const submit = async () => {
    const normalized = normalizeAccount(kind, number);
    if (!normalized) return setError(kind === "bank" ? t("accounts.error.invalidBank") : t("accounts.error.invalidWallet"));
    if (existing.some((a) => a.institution === chosen && a.account_masked === maskAccount(normalized))) return setError(t("accounts.error.duplicate"));
    setSaving(true);
    setError(null);
    const err = await onSave(chosen!, number, makeActive);
    if (err) setError(err);
    setSaving(false);
  };

  const row = (name: string) => (
    <li key={name}>
      <button onClick={() => setChosen(name)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-slate-800">
        <InstitutionBadge name={name} className="h-9 w-9 text-xs" />
        <span className="font-medium">{name}</span>
      </button>
    </li>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="flex max-h-[88vh] w-full max-w-md flex-col rounded-t-3xl border border-slate-700 bg-slate-900 sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <h3 className="text-lg font-bold">{chosen ? t("accounts.addTo", { name: chosen }) : kind === "bank" ? t("accounts.picker.titleBank") : t("accounts.picker.titleWallet")}</h3>
          <button onClick={onClose} aria-label={t("common.close")} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800">
            <X className="h-5 w-5" />
          </button>
        </div>

        {!chosen ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="relative px-5 pt-4">
              <Search className="pointer-events-none absolute left-8 top-[1.65rem] h-4 w-4 text-slate-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("accounts.picker.search")}
                autoFocus
                className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 pl-9 pr-3 text-base placeholder:text-slate-600 focus:border-brand focus:outline-none"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2">
              {!query.trim() && (
                <>
                  <p className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{t("accounts.picker.popular")}</p>
                  <ul>{popular.map(row)}</ul>
                  <p className="px-2 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">{t("accounts.picker.all")}</p>
                </>
              )}
              {matches.length ? <ul>{matches.map(row)}</ul> : <p className="px-2 py-6 text-center text-sm text-slate-500">{t("accounts.picker.none")}</p>}
            </div>
          </div>
        ) : (
          <div className="space-y-4 px-5 py-5">
            <div className="flex items-center gap-3 rounded-xl bg-slate-950 p-3">
              <InstitutionBadge name={chosen} />
              <span className="font-semibold">{chosen}</span>
              <button onClick={() => { setChosen(null); setError(null); }} className="ml-auto text-sm text-slate-400 underline">
                {t("common.back")}
              </button>
            </div>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">{kind === "bank" ? t("accounts.number.bank") : t("accounts.number.wallet")}</span>
              <input
                value={number}
                onChange={(e) => { setNumber(e.target.value); setError(null); }}
                inputMode={kind === "bank" ? "numeric" : "tel"}
                autoFocus
                maxLength={24}
                onKeyDown={(e) => e.key === "Enter" && number.trim() && void submit()}
                className="h-14 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-xl tracking-wide placeholder:text-slate-600 focus:border-brand focus:outline-none"
                placeholder={kind === "bank" ? "1000 1234 5678" : "0911 223 344"}
              />
              <span className="block text-xs text-slate-500">{kind === "bank" ? t("accounts.number.hintBank") : t("accounts.number.hintWallet")}</span>
            </label>
            {hasActive && (
              <label className="flex items-center gap-3 rounded-xl bg-slate-950 p-3 text-sm">
                <input type="checkbox" checked={makeActive} onChange={(e) => setMakeActive(e.target.checked)} className="h-5 w-5 accent-emerald-500" />
                {t("accounts.makeActive")}
              </label>
            )}
            {error && <p className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</p>}
            <button
              onClick={submit}
              disabled={saving || !number.trim()}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand text-lg font-bold text-slate-950 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Check className="h-5 w-5" />} {saving ? t("accounts.saving") : t("common.save")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Confirm({ title, body, confirmLabel, cancelLabel, onConfirm, onCancel }: { title: string; body: string; confirmLabel: string; cancelLabel: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5" role="alertdialog" aria-modal="true" onClick={onCancel}>
      <div className="w-full max-w-sm space-y-3 rounded-2xl border border-slate-700 bg-slate-900 p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold">{title}</h3>
        <p className="text-sm text-slate-400">{body}</p>
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button onClick={onCancel} className="h-12 rounded-xl border border-slate-600 font-semibold">
            {cancelLabel}
          </button>
          <button onClick={onConfirm} className="h-12 rounded-xl bg-rose-500 font-bold text-white">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------------------------- the shop QR / sticker */

function ShopQr({ merchant, ready }: { merchant: Merchant; ready: boolean }) {
  const t = useT();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState(""); // browser-only: reading window while rendering breaks hydration
  const url = origin ? `${origin}/t/${merchant.terminal_id}` : "";

  useEffect(() => {
    setOrigin(window.location.origin);
    fetch(`/api/merchants/${merchant.id}/profile`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setEnabled(d.static_qr_enabled !== false))
      .catch(() => setEnabled(true));
  }, [merchant.id]);

  const toggle = async (on: boolean) => {
    setEnabled(on);
    await fetch(`/api/merchants/${merchant.id}/profile`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ static_qr_enabled: on }) }).catch(() => setEnabled(!on));
  };

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <h3 className="font-semibold">{t("accounts.shop.title")}</h3>
      <p className="mb-3 text-sm text-slate-400">{t("accounts.shop.body")}</p>
      {!ready ? (
        <p className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-200">{t("accounts.shop.needsSetup")}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <div className="rounded-xl bg-white p-3">
            <QRCodeSVG value={url} size={132} level="M" marginSize={0} />
          </div>
          <div className="min-w-0 flex-1 space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={enabled ?? true} onChange={(e) => void toggle(e.target.checked)} className="h-5 w-5 accent-emerald-500" />
              {t("accounts.shop.allow")}
            </label>
            {enabled === false && <p className="text-xs text-amber-300">{t("accounts.shop.disabled")}</p>}
            <div className="flex flex-wrap gap-2">
              <Link href={`/poster/${merchant.terminal_id}`} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 font-semibold text-slate-950">
                <Printer className="h-4 w-4" /> {t("accounts.shop.print")}
              </Link>
              <button
                onClick={async () => {
                  await navigator.clipboard.writeText(url).catch(() => {});
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1800);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 px-3 py-2 font-semibold"
              >
                {copied ? <Check className="h-4 w-4 text-brand" /> : <Copy className="h-4 w-4" />} {copied ? t("common.copied") : t("accounts.shop.copy")}
              </button>
            </div>
            <p className="break-all font-mono text-[11px] text-slate-500">{url}</p>
            <p className="text-xs text-slate-500">{t("accounts.shop.nfc")}</p>
          </div>
        </div>
      )}
    </section>
  );
}
