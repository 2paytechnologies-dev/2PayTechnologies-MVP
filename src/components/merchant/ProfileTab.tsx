"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BadgeCheck, Clock, Download, FileWarning, Loader2, LogOut, ShieldQuestion } from "lucide-react";
import type { Merchant } from "@/lib/types";
import type { KycStatus } from "@/lib/kyc";
import { nativeInfo } from "@/lib/native";
import { APP_VERSION } from "@/lib/brand";
import { useT, type Key } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface Profile {
  legal_name: string | null;
  tin_masked: string;
  has_tin: boolean;
  business_license: string | null;
  address: string | null;
  location: string | null;
  kyc_status: KycStatus;
  kyc_note: string | null;
  sms_receipts: boolean;
}

const STATUS_STYLE: Record<KycStatus, { cls: string; Icon: typeof BadgeCheck }> = {
  UNVERIFIED: { cls: "border-slate-600 bg-slate-800 text-slate-200", Icon: ShieldQuestion },
  SUBMITTED: { cls: "border-sky-500/40 bg-sky-500/10 text-sky-200", Icon: Clock },
  VERIFIED: { cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200", Icon: BadgeCheck },
  REJECTED: { cls: "border-rose-500/40 bg-rose-500/10 text-rose-200", Icon: FileWarning },
};

export function ProfileTab({ merchant, signedIn, onSignOut }: { merchant: Merchant; signedIn: boolean; onSignOut: () => void }) {
  const t = useT();
  const [p, setP] = useState<Profile | null>(null);
  const [form, setForm] = useState({ legal_name: "", tin: "", business_license: "", address: "", location: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = useCallback((d: Profile) => {
    setP(d);
    setForm({ legal_name: d.legal_name ?? "", tin: "", business_license: d.business_license ?? "", address: d.address ?? "", location: d.location ?? "" });
  }, []);

  useEffect(() => {
    fetch(`/api/merchants/${merchant.id}/profile`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? t("common.errorGeneric"));
        apply(d);
      })
      .catch((e) => setError((e as Error).message));
  }, [merchant.id, apply, t]);

  const put = async (body: Record<string, unknown>) => {
    const r = await fetch(`/api/merchants/${merchant.id}/profile`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error ?? t("common.errorGeneric"));
    return d as Profile;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // The TIN is only sent when typed; it is never shown back, so leaving it blank means "keep what is on file".
      apply(await put({ ...form, tin: form.tin || undefined }));
      setNotice(t("profile.submitted"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const status = p?.kyc_status ?? "UNVERIFIED";
  const S = STATUS_STYLE[status];
  const app = typeof window !== "undefined" ? nativeInfo() : null;
  const input = "h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-base placeholder:text-slate-600 focus:border-brand focus:outline-none";

  return (
    <div className="space-y-5">
      <h2 className="text-xl font-bold">{t("profile.title")}</h2>

      <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">{t("profile.verify.title")}</h3>
          <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold", S.cls)}>
            <S.Icon className="h-3.5 w-3.5" /> {t(`profile.status.${status}` as Key)}
          </span>
        </div>
        <p className="text-sm text-slate-400">{t("profile.verify.why")}</p>
        {status === "REJECTED" && p?.kyc_note && (
          <p className="rounded-lg bg-rose-500/10 p-3 text-sm text-rose-200">
            {t("profile.rejectedNote")}: {p.kyc_note}
          </p>
        )}

        {!p && !error ? (
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-500" />
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <Field label={t("profile.f.legalName")}>
              <input className={input} value={form.legal_name} onChange={(e) => setForm({ ...form, legal_name: e.target.value })} maxLength={120} />
            </Field>
            <Field label={t("profile.f.tin")} hint={p?.has_tin ? t("profile.f.tinSaved", { tin: p.tin_masked }) : undefined}>
              <input className={input} value={form.tin} onChange={(e) => setForm({ ...form, tin: e.target.value })} inputMode="numeric" maxLength={14} placeholder={p?.has_tin ? p.tin_masked : "0012345678"} />
            </Field>
            <Field label={t("profile.f.license")}>
              <input className={input} value={form.business_license} onChange={(e) => setForm({ ...form, business_license: e.target.value })} maxLength={60} />
            </Field>
            <Field label={t("profile.f.address")}>
              <input className={input} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} maxLength={200} />
            </Field>
            <Field label={t("profile.f.area")}>
              <input className={input} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} maxLength={200} placeholder={t("profile.f.areaPh")} />
            </Field>
            {error && <p className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</p>}
            {notice && <p className="rounded-lg bg-emerald-500/15 p-3 text-sm text-emerald-300">{notice}</p>}
            <button
              type="submit"
              disabled={busy || status === "SUBMITTED" || (!form.tin && !p?.has_tin)}
              className="inline-flex h-12 items-center gap-2 rounded-xl bg-brand px-5 font-bold text-slate-950 disabled:opacity-50"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("profile.submit")}
            </button>
          </form>
        )}
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <h3 className="mb-3 font-semibold">{t("profile.prefs.title")}</h3>
        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            className="h-5 w-5 accent-emerald-500"
            checked={p?.sms_receipts ?? true}
            onChange={async (e) => {
              const on = e.target.checked;
              setP((cur) => (cur ? { ...cur, sms_receipts: on } : cur));
              await put({ sms_receipts: on }).catch(() => setP((cur) => (cur ? { ...cur, sms_receipts: !on } : cur)));
            }}
          />
          {t("profile.prefs.sms")}
        </label>
      </section>

      <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4 text-sm">
        <h3 className="font-semibold">{t("profile.about.title")}</h3>
        <div className="text-slate-400">{app ? t("profile.about.version", { v: app.version }) : t("profile.about.web", { v: APP_VERSION })}</div>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <Link href="/download" className="inline-flex items-center gap-1.5 text-brand underline">
            <Download className="h-4 w-4" /> {t("profile.about.download")}
          </Link>
          <Link href="/terms" className="text-slate-300 underline">
            {t("common.legal")}
          </Link>
          <Link href="/privacy" className="text-slate-300 underline">
            {t("common.privacy")}
          </Link>
        </div>
        {signedIn && (
          <button onClick={onSignOut} className="inline-flex items-center gap-2 rounded-xl border border-slate-600 px-4 py-2 font-semibold">
            <LogOut className="h-4 w-4" /> {t("profile.signOut")}
          </button>
        )}
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
