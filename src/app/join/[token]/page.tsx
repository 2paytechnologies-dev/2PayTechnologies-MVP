"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ShieldCheck, UserCheck, XCircle } from "lucide-react";
import { Logo } from "@/components/Logo";
import { LanguageMenu } from "@/components/LanguageMenu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT, type Key } from "@/lib/i18n";
import { getDeviceId } from "@/lib/device";
import { fetchSession } from "@/lib/client-session";

interface Invite {
  business_name: string;
  name: string;
  role: "WAITER" | "CASHIER";
  team_no: string | null;
}

type State = { kind: "loading" } | { kind: "bad" } | { kind: "ready"; invite: Invite } | { kind: "done" };

/**
 * Where a team member lands from their activation link. They see which business and team number it is for, get a code
 * on the phone number the owner entered, and confirm it: that phone is then linked to the business for taking payments.
 */
export default function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const t = useT();
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [challenge, setChallenge] = useState<{ id: string; phone: string; devCode?: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Waiters tap to pay, which only the Android app can do. Outside the app (and when sign-in is enforced) this page sends
  // them to the app instead of letting them activate a browser that could never broadcast a tap.
  const [inApp, setInApp] = useState(true);
  const [enforced, setEnforced] = useState(false);

  useEffect(() => {
    setInApp(typeof window !== "undefined" && !!window.TwoPayNative);
    void fetchSession().then((s) => setEnforced(s.enforced));
  }, []);

  useEffect(() => {
    fetch(`/api/team/invite?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((d) => setState(d.valid ? { kind: "ready", invite: d } : { kind: "bad" }))
      .catch(() => setState({ kind: "bad" }));
  }, [token]);

  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? t("common.errorGeneric"));
    return data;
  };

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await post("/api/auth/otp/request", { invite_token: token });
      setChallenge({ id: d.challenge_id, phone: d.phone, devCode: d.dev_code });
      setCode("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      await post("/api/auth/otp/verify", { challenge_id: challenge.id, code, invite_token: token, device_id: getDeviceId() });
      setState({ kind: "done" });
      setTimeout(() => {
        router.replace("/dashboard/merchant");
        router.refresh();
      }, 900);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-5">
      <div className="flex items-center gap-2 text-brand">
        <Logo /> <span className="text-xl font-bold text-white">2Pay</span>
        <LanguageMenu className="ml-auto" />
      </div>

      {state.kind === "loading" && (
        <div className="flex items-center justify-center gap-2 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" /> {t("common.loading")}
        </div>
      )}

      {state.kind === "bad" && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 p-8 text-center">
          <XCircle className="h-12 w-12 text-rose-400" />
          <p className="text-slate-200">{t("crew.join.bad")}</p>
        </div>
      )}

      {state.kind === "ready" && (
        <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <div>
            <h1 className="text-xl font-bold">{t("crew.join.title", { business: state.invite.business_name })}</h1>
            <p className="mt-1 text-slate-300">{t("crew.join.hello", { name: state.invite.name })}</p>
            <p className="text-sm text-slate-400">{t("crew.join.you", { no: state.invite.team_no ?? "—", role: t(`crew.role.${state.invite.role}` as Key) })}</p>
          </div>
          <p className="rounded-xl bg-slate-950 p-3 text-sm text-slate-300">{t("crew.join.what")}</p>

          {state.invite.role === "WAITER" && !inApp && enforced ? (
            <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
              <p className="text-sm text-amber-100">{t("crew.join.appOnly")}</p>
              <a href={`intent://activate/${token}#Intent;scheme=twopay;package=com.twopay.merchant;S.browser_fallback_url=${encodeURIComponent(`${typeof window !== "undefined" ? window.location.origin : ""}/download`)};end`} className="flex h-12 items-center justify-center rounded-xl bg-brand font-bold text-slate-950">
                {t("crew.join.openApp")}
              </a>
              <a href="/download" className="flex h-12 items-center justify-center rounded-xl border border-slate-600 font-semibold">
                {t("crew.join.getApp")}
              </a>
              <p className="text-xs text-slate-400">{t("crew.join.appHelp")}</p>
            </div>
          ) : !challenge ? (
            <Button className="w-full" onClick={sendCode} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserCheck className="h-4 w-4" />} {t("crew.join.send")}
            </Button>
          ) : (
            <form onSubmit={verify} className="space-y-3">
              <p className="text-sm text-slate-400">{t("crew.join.enter", { phone: challenge.phone })}</p>
              {challenge.devCode && (
                <button type="button" onClick={() => setCode(challenge.devCode!)} className="flex w-full items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
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
                aria-label={t("crew.join.verify")}
                autoFocus
              />
              <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} {t("crew.join.verify")}
              </Button>
              <button type="button" onClick={sendCode} disabled={busy} className="w-full text-xs text-slate-400 underline disabled:opacity-50">
                {t("auth.resend")}
              </button>
            </form>
          )}

          <p className="text-xs text-slate-500">{t("crew.join.signedOutWarn")}</p>
          {error && <div className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</div>}
        </section>
      )}

      {state.kind === "done" && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-8 text-center">
          <ShieldCheck className="h-14 w-14 text-brand" />
          <p className="text-lg font-semibold">{t("crew.join.done")}</p>
        </div>
      )}
    </main>
  );
}
