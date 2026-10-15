"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BadgeCheck, Clock, Download, FileWarning, Fingerprint, Loader2, LogOut, ShieldQuestion } from "lucide-react";
import type { Merchant } from "@/lib/types";
import type { KycStatus } from "@/lib/kyc";
import { nativeInfo } from "@/lib/native";
import { APP_VERSION } from "@/lib/brand";
import { useI18n, useT, type Key } from "@/lib/i18n";
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
  fayda_verified_at: string | null;
  fayda: { configured: boolean; ekyc: "sandbox" | "gateway" | null; required: boolean; verified: boolean; name: string | null };
}

const STATUS_STYLE: Record<KycStatus, { cls: string; Icon: typeof BadgeCheck }> = {
  UNVERIFIED: { cls: "border-slate-600 bg-slate-800 text-slate-200", Icon: ShieldQuestion },
  SUBMITTED: { cls: "border-sky-500/40 bg-sky-500/10 text-sky-200", Icon: Clock },
  VERIFIED: { cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200", Icon: BadgeCheck },
  REJECTED: { cls: "border-rose-500/40 bg-rose-500/10 text-rose-200", Icon: FileWarning },
};

export function ProfileTab({ merchant, signedIn, onSignOut }: { merchant: Merchant; signedIn: boolean; onSignOut: () => void }) {
  const t = useT();
  const { lang } = useI18n();
  const [p, setP] = useState<Profile | null>(null);
  const [faydaBusy, setFaydaBusy] = useState(false);
  const [faydaNote, setFaydaNote] = useState<{ ok: boolean; text: string } | null>(null);
  // The FAN + one-time-code route: type the 16-digit Fayda number, then the code sent to the phone linked to it.
  const [fan, setFan] = useState("");
  const [otp, setOtp] = useState("");
  const [faydaSession, setFaydaSession] = useState<{ id: string; phone: string | null } | null>(null);
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

  // Back from the national ID provider: ?fayda=ok | error | cancelled.
  useEffect(() => {
    const r = new URLSearchParams(window.location.search).get("fayda");
    if (r === "ok" || r === "error" || r === "cancelled") setFaydaNote({ ok: r === "ok", text: t(`fayda.${r}` as Key) });
  }, [t]);

  const startFayda = async () => {
    setFaydaBusy(true);
    setFaydaNote(null);
    try {
      const r = await fetch(`/api/merchants/${merchant.id}/fayda/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lang }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.code === "FAYDA_NOT_CONFIGURED" ? t("fayda.notConfigured") : (d.error ?? t("common.errorGeneric")));
      window.location.assign(d.url);
    } catch (e) {
      setFaydaNote({ ok: false, text: (e as Error).message });
      setFaydaBusy(false);
    }
  };

  const post = async (path: string, body: Record<string, unknown>) => {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, merchant_id: merchant.id }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.code === "FAYDA_NOT_CONFIGURED" ? t("fayda.notConfigured") : (d.error ?? t("common.errorGeneric")));
    return d;
  };
  const sendFanCode = async () => {
    setFaydaBusy(true);
    setFaydaNote(null);
    try {
      const d = await post("/api/kyc/fayda/initiate", { fan });
      setFaydaSession({ id: d.fayda_session_id, phone: d.phone_hint ?? null });
      setOtp("");
    } catch (e) {
      setFaydaNote({ ok: false, text: (e as Error).message });
    } finally {
      setFaydaBusy(false);
    }
  };
  const checkFanCode = async () => {
    if (!faydaSession) return;
    setFaydaBusy(true);
    setFaydaNote(null);
    try {
      const d = await post("/api/kyc/fayda/verify-otp", { fayda_session_id: faydaSession.id, otp });
      setFaydaSession(null);
      setFan("");
      setOtp("");
      setFaydaNote({ ok: true, text: t("fayda.ok") });
      setP((cur) => (cur ? { ...cur, fayda_verified_at: new Date().toISOString(), fayda: { ...cur.fayda, verified: true, name: d.name ?? cur.fayda.name } } : cur));
    } catch (e) {
      setFaydaNote({ ok: false, text: (e as Error).message });
    } finally {
      setFaydaBusy(false);
    }
  };
  const faydaDone = !!(p?.fayda.verified || p?.fayda_verified_at);

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

      <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 font-semibold">
            <Fingerprint className="h-4 w-4 text-brand" /> {t("fayda.title")}
          </h3>
          {faydaDone && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-200">
              <BadgeCheck className="h-3.5 w-3.5" /> {p.fayda.name ? t("fayda.verified", { name: p.fayda.name }) : t("fayda.verifiedPlain")}
            </span>
          )}
        </div>
        <p className="text-sm text-slate-400">{t("fayda.body")}</p>
        {p?.fayda.required && !faydaDone && <p className="text-xs text-amber-300">{t("fayda.required")}</p>}
        {p && !p.fayda.configured && !p.fayda.ekyc && <p className="rounded-lg bg-slate-800 p-3 text-xs text-slate-300">{t("fayda.notConfigured")}</p>}
        {faydaNote && <p className={cn("rounded-lg p-3 text-sm", faydaNote.ok ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300")}>{faydaNote.text}</p>}
        {p?.fayda.ekyc && !faydaDone && (
          <div className="space-y-3 rounded-xl border border-slate-700 bg-slate-950 p-3">
            {p.fayda.ekyc === "sandbox" && <p className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-200">{t("fayda.fan.sandbox")}</p>}
            {!faydaSession ? (
              <>
                <Field label={t("fayda.fan.label")}>
                  <input className={input} value={fan} onChange={(e) => setFan(e.target.value.replace(/[^0-9 -]/g, ""))} inputMode="numeric" autoComplete="off" maxLength={19} placeholder="0000 0000 0000 0000" />
                </Field>
                <button onClick={sendFanCode} disabled={faydaBusy || fan.replace(/\D/g, "").length !== 16} className="inline-flex h-12 items-center gap-2 rounded-xl bg-brand px-5 font-bold text-slate-950 disabled:opacity-50">
                  {faydaBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />} {t("fayda.fan.send")}
                </button>
              </>
            ) : (
              <>
                <p className="text-sm text-slate-300">{faydaSession.phone ? t("fayda.fan.sentTo", { phone: faydaSession.phone }) : t("fayda.fan.sent")}</p>
                <Field label={t("fayda.fan.otpLabel")}>
                  <input className={input} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} inputMode="numeric" autoComplete="one-time-code" maxLength={8} />
                </Field>
                <div className="flex flex-wrap items-center gap-3">
                  <button onClick={checkFanCode} disabled={faydaBusy || otp.length < 4} className="inline-flex h-12 items-center gap-2 rounded-xl bg-brand px-5 font-bold text-slate-950 disabled:opacity-50">
                    {faydaBusy && <Loader2 className="h-4 w-4 animate-spin" />} {t("fayda.fan.verify")}
                  </button>
                  <button onClick={() => { setFaydaSession(null); setOtp(""); setFaydaNote(null); }} className="text-sm text-slate-400 underline">{t("fayda.fan.change")}</button>
                </div>
              </>
            )}
          </div>
        )}
        {!faydaDone && p?.fayda.configured && (
          <button onClick={startFayda} disabled={faydaBusy || !p?.fayda.configured} className={cn("inline-flex h-12 items-center gap-2 rounded-xl px-5 font-bold disabled:opacity-50", p?.fayda.ekyc ? "border border-slate-600 text-slate-200" : "bg-brand text-slate-950")}>
            {faydaBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />} {t("fayda.cta")}
          </button>
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
