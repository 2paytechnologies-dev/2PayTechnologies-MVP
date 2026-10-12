"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, FlaskConical, Loader2, ShieldCheck, Store } from "lucide-react";
import { Logo } from "@/components/Logo";
import { LanguageMenu } from "@/components/LanguageMenu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT, type Key } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type Mode = "login" | "register";
type Category = "Fuel" | "Retail";

interface Props {
  testMode: boolean;
  next: string;
  initialMode: Mode;
}

const QUICK_LINKS: { href: string; label: Key; note: Key }[] = [
  { href: "/dashboard/merchant", label: "auth.quick.portal", note: "auth.quick.portalNote" },
  { href: "/terminal", label: "auth.quick.terminal", note: "auth.quick.terminalNote" },
  { href: "/dashboard/merchant?tab=accounts", label: "auth.quick.accounts", note: "auth.quick.accountsNote" },
  { href: "/dashboard/admin", label: "auth.quick.admin", note: "auth.quick.adminNote" },
];

export function SignInForm({ testMode, next, initialMode }: Props) {
  const t = useT();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [phone, setPhone] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [category, setCategory] = useState<Category>("Retail");
  const [accepted, setAccepted] = useState(false);
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<{ id: string; phone: string; devCode?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchMode = (m: Mode) => {
    setMode(m);
    setChallenge(null);
    setCode("");
    setError(null);
  };

  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? t("common.errorGeneric"));
    return data;
  };

  const sendCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    if (mode === "register") {
      if (businessName.trim().length < 2) return setError(t("auth.needName"));
      if (!accepted) return setError(t("auth.mustAccept"));
    }
    setBusy(true);
    try {
      const d = await post("/api/auth/otp/request", { phone, purpose: mode });
      setChallenge({ id: d.challenge_id, phone: d.phone, devCode: d.dev_code });
      setCode("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!challenge) return;
    setError(null);
    setBusy(true);
    try {
      const d = await post("/api/auth/otp/verify", { challenge_id: challenge.id, code, business_name: businessName, category, accepted_terms: accepted });
      // A brand-new merchant goes straight to "Get paid" so the next thing they see is how to start receiving money.
      router.replace(d.created ? "/dashboard/merchant?tab=accounts&welcome=1" : next);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-5">
      <div className="flex items-center gap-2 text-brand">
        <Logo /> <h1 className="text-xl font-bold text-white">{t("auth.title")}</h1>
        <LanguageMenu className="ml-auto" />
      </div>

      {testMode && (
        <section className="space-y-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4">
          <div className="flex items-start gap-2 text-sm text-amber-100">
            <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <p>
              <b>{t("auth.test.title")}</b> {t("auth.test.body")}
            </p>
          </div>
          <Link href={next} className="flex items-center justify-center gap-2 rounded-xl bg-amber-400 py-3 font-bold text-slate-950 active:scale-[0.99]">
            {t("common.signIn")} <ArrowRight className="h-4 w-4" />
          </Link>
          <div className="grid grid-cols-2 gap-2">
            {QUICK_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="rounded-lg border border-amber-500/20 bg-slate-950/40 px-3 py-2 text-xs hover:border-amber-400/50">
                <span className="block font-semibold text-amber-100">{t(l.label)}</span>
                <span className="text-amber-200/60">{t(l.note)}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-950 p-1 text-sm" role="tablist">
          {(["login", "register"] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} onClick={() => switchMode(m)} className={cn("rounded-md py-2 font-medium", mode === m ? "bg-slate-700 text-white" : "text-slate-400")}>
              {m === "login" ? t("common.signIn") : t("common.register")}
            </button>
          ))}
        </div>

        {!challenge ? (
          <form onSubmit={sendCode} className="space-y-3">
            {mode === "register" && (
              <>
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-slate-300">{t("auth.businessName")}</span>
                  <Input value={businessName} onChange={(e) => setBusinessName(e.target.value)} maxLength={80} placeholder={t("auth.businessNamePh")} autoComplete="organization" />
                </label>
                <div className="space-y-1">
                  <span className="text-xs font-medium text-slate-300">{t("auth.businessType")}</span>
                  <div className="grid grid-cols-2 gap-2">
                    {(["Retail", "Fuel"] as const).map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setCategory(c)}
                        className={cn("rounded-lg border py-2 text-sm font-medium", category === c ? "border-brand bg-brand/10 text-white" : "border-slate-700 text-slate-400")}
                      >
                        {t(`auth.type.${c}` as Key)}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-300">{t("common.phone")}</span>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" placeholder="0911 223 344" maxLength={20} />
            </label>
            {mode === "register" && (
              <label className="flex items-start gap-2.5 text-sm text-slate-300">
                <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-emerald-500" />
                <span>
                  {t("auth.terms.pre")}
                  <Link href="/terms" target="_blank" className="text-brand underline">
                    {t("common.legal")}
                  </Link>
                  {t("auth.terms.mid")}
                  <Link href="/privacy" target="_blank" className="text-brand underline">
                    {t("common.privacy")}
                  </Link>
                  {t("auth.terms.post")}
                </span>
              </label>
            )}
            {mode === "login" && <p className="text-xs text-slate-500">{t("auth.cashierHint")}</p>}
            <Button type="submit" className="w-full" disabled={busy || !phone.trim()}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("auth.sendCode")}
            </Button>
          </form>
        ) : (
          <form onSubmit={verify} className="space-y-3">
            <p className="text-sm text-slate-400">{challenge.devCode ? t("auth.enterCodeDev", { phone: challenge.phone }) : t("auth.enterCodeSms", { phone: challenge.phone })}</p>
            {challenge.devCode && (
              <button
                type="button"
                onClick={() => setCode(challenge.devCode!)}
                className="flex w-full items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200"
              >
                <span>{t("auth.devCode")}</span>
                <span className="font-mono text-lg font-bold tracking-widest">{challenge.devCode}</span>
              </button>
            )}
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="••••••"
              className="text-center font-mono text-2xl tracking-[0.5em]"
              aria-label={t("auth.verifyLogin")}
              autoFocus
            />
            <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : mode === "register" ? <Store className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
              {mode === "register" ? t("auth.verifyRegister") : t("auth.verifyLogin")}
            </Button>
            <div className="flex justify-between text-xs">
              <button type="button" onClick={() => setChallenge(null)} className="text-slate-400 underline">
                {t("auth.changeNumber")}
              </button>
              <button type="button" onClick={() => sendCode()} disabled={busy} className="text-slate-400 underline disabled:opacity-50">
                {t("auth.resend")}
              </button>
            </div>
          </form>
        )}

        {error && <div className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</div>}
      </section>

      <p className="text-center text-xs text-slate-500">
        <Link href="/terms" className="underline">
          {t("common.legal")}
        </Link>
        {" · "}
        <Link href="/privacy" className="underline">
          {t("common.privacy")}
        </Link>
      </p>
    </main>
  );
}
