"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, Link2, Loader2, Share2, Trash2, UserPlus, Users } from "lucide-react";
import type { Merchant } from "@/lib/types";
import { useT, type Key } from "@/lib/i18n";
import { ShiftLedger } from "@/components/merchant/ShiftLedger";
import { cn } from "@/lib/utils";
import { formatEAT } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

type Role = "WAITER" | "CASHIER";
type Status = "INVITED" | "ACTIVE" | "EXPIRED";

interface Member {
  id: string;
  name: string;
  role: Role;
  team_no: string | null;
  status: Status;
  phone_masked: string;
  device_label: string | null;
  last_seen_at: string | null;
  created_at: string;
}

interface Invite {
  member: { id: string; name: string; team_no: string | null };
  link: string;
  smsSent: boolean;
}

const STATUS_TONE: Record<Status, string> = {
  ACTIVE: "bg-emerald-500/15 text-emerald-300",
  INVITED: "bg-amber-500/15 text-amber-200",
  EXPIRED: "bg-rose-500/15 text-rose-300",
};

/**
 * The owner's team: any number of waiters and cashiers. Each gets a team number and a one-time activation link; once
 * they open it on their own phone and confirm the code we text them, that phone takes payments straight into the
 * business account and every sale names the person who took it.
 */
export function TeamTab({ merchant }: { merchant: Merchant }) {
  const t = useT();
  const { lang } = useI18n();
  const [team, setTeam] = useState<Member[] | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<Role>("WAITER");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [copied, setCopied] = useState(false);

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
    try {
      const r = await fetch(`/api/merchants/${merchant.id}/staff`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, phone, role }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? t("common.errorGeneric"));
      setName("");
      setPhone("");
      setCopied(false);
      setInvite({ member: { id: d.id, name: d.name, team_no: d.team_no }, link: d.invite_link, smsSent: !!d.sms_sent });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reissue = async (m: Member) => {
    setError(null);
    try {
      const r = await fetch(`/api/merchants/${merchant.id}/staff/${m.id}`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? t("common.errorGeneric"));
      setCopied(false);
      setInvite({ member: { id: m.id, name: m.name, team_no: m.team_no }, link: d.invite_link, smsSent: !!d.sms_sent });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (m: Member) => {
    setRemoving(null);
    await fetch(`/api/merchants/${merchant.id}/staff/${m.id}`, { method: "DELETE" }).catch(() => {});
    await load();
  };

  const copy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.link);
      setCopied(true);
    } catch {
      /* the link is shown on screen to copy by hand */
    }
  };

  const share = async () => {
    if (!invite) return;
    try {
      await navigator.share({ text: t("crew.link.shareText", { link: invite.link }) });
    } catch {
      /* cancelled, or not supported: Copy is always there */
    }
  };

  const input = "h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-base placeholder:text-slate-600 focus:border-brand focus:outline-none";
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  return (
    <div className="space-y-5">
      <header>
        <h2 className="flex items-center gap-2 text-xl font-bold">
          <Users className="h-5 w-5 text-brand" /> {t("team.title")}
        </h2>
        <p className="mt-1 text-sm text-slate-400">{t("team.intro")}</p>
      </header>

      <ShiftLedger merchantId={merchant.id} />

      <form onSubmit={add} className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <h3 className="font-semibold">{t("team.add")}</h3>

        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("crew.role")}>
          {(["WAITER", "CASHIER"] as const).map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={role === r}
              onClick={() => setRole(r)}
              className={cn("rounded-xl border p-3 text-left", role === r ? "border-brand bg-brand/10" : "border-slate-700 text-slate-400")}
            >
              <span className="block font-semibold text-white">{t(`crew.role.${r}` as Key)}</span>
              <span className="mt-0.5 block text-xs">{t(`crew.roleHelp.${r}` as Key)}</span>
            </button>
          ))}
        </div>

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
        <button type="submit" disabled={busy || name.trim().length < 2 || !phone.trim()} className="inline-flex h-12 items-center gap-2 rounded-xl bg-brand px-5 font-bold text-slate-950 disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} {t("team.addBtn")}
        </button>
      </form>

      {invite && (
        <section className="space-y-3 rounded-2xl border border-brand/40 bg-brand/5 p-4" aria-live="polite">
          <h3 className="flex items-center gap-2 font-semibold">
            <Link2 className="h-4 w-4 text-brand" /> {t("crew.link.title", { name: invite.member.name })}
            {invite.member.team_no && <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-xs text-slate-300">{invite.member.team_no}</span>}
          </h3>
          <p className="text-sm text-slate-300">{t("crew.link.note", { name: invite.member.name })}</p>
          <div className="break-all rounded-xl bg-slate-950 p-3 font-mono text-xs text-slate-300">{invite.link}</div>
          <p className={cn("text-xs", invite.smsSent ? "text-emerald-300" : "text-amber-200")}>{invite.smsSent ? t("crew.link.smsSent") : t("crew.link.smsOff")}</p>
          <div className="flex flex-wrap gap-2">
            <button onClick={copy} className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand px-4 font-semibold text-slate-950">
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? t("crew.link.copied") : t("crew.link.copy")}
            </button>
            {canShare && (
              <button onClick={share} className="inline-flex h-11 items-center gap-2 rounded-xl border border-slate-600 px-4 font-semibold">
                <Share2 className="h-4 w-4" /> {t("crew.link.share")}
              </button>
            )}
            <button onClick={() => setInvite(null)} className="ml-auto h-11 rounded-xl px-4 text-slate-400 underline">
              {t("crew.close")}
            </button>
          </div>
        </section>
      )}

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
            <li key={m.id} className="space-y-2 py-3 text-sm">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{m.name}</span>
                    {m.team_no && <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">{m.team_no}</span>}
                  </div>
                  <div className="font-mono text-xs text-slate-500">{m.phone_masked}</div>
                </div>
                <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300">{t(`crew.role.${m.role}` as Key)}</span>
                <button onClick={() => setRemoving(m)} aria-label={`${t("common.remove")} ${m.name}`} className="rounded-lg p-2 text-rose-300 hover:bg-rose-500/10">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className={cn("rounded-full px-2 py-0.5 font-medium", STATUS_TONE[m.status])}>{t(`crew.status.${m.status}` as Key)}</span>
                <span className="text-slate-500">
                  {m.status === "ACTIVE"
                    ? [m.device_label ? t("crew.device", { label: m.device_label }) : null, m.last_seen_at ? t("crew.lastSeen", { when: formatEAT(m.last_seen_at, lang) }) : null].filter(Boolean).join(" · ")
                    : t("crew.neverSeen")}
                </span>
                <button onClick={() => void reissue(m)} title={t("crew.link.newBody")} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1 text-slate-300 hover:border-brand">
                  <KeyRound className="h-3.5 w-3.5" /> {t("crew.link.new")}
                </button>
              </div>
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
