"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Trash2, UserPlus, Users } from "lucide-react";
import type { Merchant } from "@/lib/types";
import { useT } from "@/lib/i18n";

interface Member {
  id: string;
  name: string;
  phone_masked: string;
  created_at: string;
}

/** The owner's cashiers. A cashier signs in with their own phone and can only run the terminal. */
export function TeamTab({ merchant }: { merchant: Merchant }) {
  const t = useT();
  const [team, setTeam] = useState<Member[] | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/merchants/${merchant.id}/staff`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? t("common.errorGeneric"));
      setTeam(d);
    } catch (e) {
      setError((e as Error).message);
      setTeam([]);
    }
  }, [merchant.id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await fetch(`/api/merchants/${merchant.id}/staff`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, phone }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? t("common.errorGeneric"));
      setName("");
      setPhone("");
      setNotice(t("team.added"));
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (m: Member) => {
    setRemoving(null);
    await fetch(`/api/merchants/${merchant.id}/staff/${m.id}`, { method: "DELETE" }).catch(() => {});
    await load();
  };

  const input = "h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-base placeholder:text-slate-600 focus:border-brand focus:outline-none";

  return (
    <div className="space-y-5">
      <header>
        <h2 className="flex items-center gap-2 text-xl font-bold">
          <Users className="h-5 w-5 text-brand" /> {t("team.title")}
        </h2>
        <p className="mt-1 text-sm text-slate-400">{t("team.intro")}</p>
      </header>

      <form onSubmit={add} className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <h3 className="font-semibold">{t("team.add")}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-300">{t("team.name")}</span>
            <input className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t("team.namePh")} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-300">{t("team.phone")}</span>
            <input className={input} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="0911 223 344" maxLength={20} />
          </label>
        </div>
        {error && <p className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</p>}
        {notice && <p className="rounded-lg bg-emerald-500/15 p-3 text-sm text-emerald-300">{notice}</p>}
        <button type="submit" disabled={busy || name.trim().length < 2 || !phone.trim()} className="inline-flex h-12 items-center gap-2 rounded-xl bg-brand px-5 font-bold text-slate-950 disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} {t("team.addBtn")}
        </button>
      </form>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <ul className="divide-y divide-slate-800">
          <li className="flex items-center justify-between py-3 text-sm">
            <span className="font-medium">{merchant.business_name}</span>
            <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300">{t("team.owner")}</span>
          </li>
          {team === null && (
            <li className="py-4 text-center text-slate-500">
              <Loader2 className="mx-auto h-5 w-5 animate-spin" />
            </li>
          )}
          {team?.map((m) => (
            <li key={m.id} className="flex items-center gap-3 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{m.name}</div>
                <div className="font-mono text-xs text-slate-500">{m.phone_masked}</div>
              </div>
              <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300">{t("team.cashier")}</span>
              <button onClick={() => setRemoving(m)} aria-label={`${t("common.remove")} ${m.name}`} className="rounded-lg p-2 text-rose-300 hover:bg-rose-500/10">
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
        {team?.length === 0 && <p className="pt-2 text-sm text-slate-500">{t("team.empty")}</p>}
      </section>

      {removing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5" role="alertdialog" aria-modal="true" onClick={() => setRemoving(null)}>
          <div className="w-full max-w-sm space-y-3 rounded-2xl border border-slate-700 bg-slate-900 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold">{t("team.removeConfirm", { name: removing.name })}</h3>
            <p className="text-sm text-slate-400">{t("team.removeBody")}</p>
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button onClick={() => setRemoving(null)} className="h-12 rounded-xl border border-slate-600 font-semibold">
                {t("common.cancel")}
              </button>
              <button onClick={() => void remove(removing)} className="h-12 rounded-xl bg-rose-500 font-bold text-white">
                {t("common.remove")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
