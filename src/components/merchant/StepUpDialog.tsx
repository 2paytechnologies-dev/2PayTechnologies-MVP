"use client";

import { useEffect, useState } from "react";
import { KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { useT } from "@/lib/i18n";
import { enrollRequest, enrollVerify, unlockRequest, unlockVerify, vaultStatus, type Challenge, type VaultStatus } from "@/lib/settlement-client";

type Step = "loading" | "setup-phone" | "setup-key" | "key" | "code";

/**
 * "Confirm it's you": adding, editing or removing a bank or wallet needs two locks, the approver's 6-digit security key AND a
 * one-time code sent to the approver's own phone. Shown automatically when the server asks. It handles three situations:
 * first time (choose a phone and a key), normal (key, then code) and locked (too many wrong keys).
 */
export function StepUpDialog({ merchantId, onVerified, onCancel }: { merchantId: string; onVerified: () => void; onCancel: () => void }) {
  const t = useT();
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [step, setStep] = useState<Step>("loading");
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fail = (e: unknown) => {
    const err = e as Error & { minutes?: number };
    setError(err.minutes ? t("vault.locked", { m: err.minutes }) : err.message === "request" ? t("common.errorGeneric") : err.message);
  };

  useEffect(() => {
    vaultStatus(merchantId)
      .then((s) => {
        setStatus(s);
        if (s.locked_minutes > 0) setError(t("vault.locked", { m: s.locked_minutes }));
        setStep(!s.has_phone ? "setup-phone" : !s.has_pin ? "setup-key" : "key");
      })
      .catch((e) => {
        fail(e);
        setStep("key");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchantId]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  // First time: a code to the phone (given now if the business has none yet), then key + code together.
  const sendSetupCode = () =>
    run(async () => {
      const c = await enrollRequest(merchantId, status?.has_phone ? undefined : phone);
      setChallenge(c);
      setStep("setup-key");
    });
  const saveKey = () =>
    run(async () => {
      if (pin !== pin2) throw new Error(t("vault.setup.mismatch"));
      if (!challenge) throw new Error(t("common.errorGeneric"));
      await enrollVerify(merchantId, challenge.challenge_id, code, pin, status?.has_phone ? undefined : phone);
      onVerified(); // saving the key also opened the vault, so the change goes through now
    });

  // Normal: key, then code.
  const sendKey = () =>
    run(async () => {
      const c = await unlockRequest(merchantId, pin);
      setChallenge(c);
      setCode("");
      setStep("code");
    });
  const confirmCode = () =>
    run(async () => {
      if (!challenge) throw new Error(t("common.errorGeneric"));
      await unlockVerify(merchantId, challenge.challenge_id, code);
      onVerified();
    });

  const digits = (v: string) => v.replace(/\D/g, "").slice(0, 6);
  const box = "h-14 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-center font-mono text-2xl tracking-[0.5em] focus:border-brand focus:outline-none";
  const primary = "flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand font-bold text-slate-950 disabled:opacity-50";
  const devCode = challenge?.dev_code;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-5" role="dialog" aria-modal="true" aria-labelledby="stepup-title">
      <div className="w-full max-w-sm space-y-4 rounded-2xl border border-slate-700 bg-slate-900 p-5">
        <h3 id="stepup-title" className="flex items-center gap-2 text-lg font-bold">
          <ShieldCheck className="h-5 w-5 text-brand" /> {step === "setup-phone" || step === "setup-key" ? t("vault.setup.title") : t("vault.stepup.title")}
        </h3>

        {step === "loading" && <Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-500" />}

        {step === "setup-phone" && (
          <div className="space-y-3">
            <p className="text-sm text-slate-300">{t("vault.setup.bodyPhone")}</p>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-300">{t("vault.setup.phone")}</span>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" placeholder="0911 223 344" maxLength={20} className="h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-lg focus:border-brand focus:outline-none" />
            </label>
            <button onClick={sendSetupCode} disabled={busy || !phone.trim()} className={primary}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("vault.setup.send")}
            </button>
          </div>
        )}

        {step === "setup-key" && (
          <div className="space-y-3">
            <p className="text-sm text-slate-300">{t("vault.setup.bodyPin")}</p>
            {!challenge ? (
              <button onClick={sendSetupCode} disabled={busy} className={primary}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("vault.setup.send")}
              </button>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveKey();
                }}
                className="space-y-3"
              >
                <p className="text-sm text-emerald-300">{t("vault.stepup.sent", { phone: challenge.phone_masked })}</p>
                {devCode && (
                  <button type="button" onClick={() => setCode(devCode)} className="flex w-full items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                    <span>{t("auth.devCode")}</span>
                    <span className="font-mono text-lg font-bold tracking-widest">{devCode}</span>
                  </button>
                )}
                <input value={code} onChange={(e) => setCode(digits(e.target.value))} inputMode="numeric" autoComplete="one-time-code" placeholder="••••••" aria-label={t("vault.stepup.enter")} className={box} />
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-slate-300">{t("vault.setup.key")}</span>
                  <input value={pin} onChange={(e) => setPin(digits(e.target.value))} type="password" inputMode="numeric" autoComplete="new-password" placeholder="••••••" className={box} />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-slate-300">{t("vault.setup.keyAgain")}</span>
                  <input value={pin2} onChange={(e) => setPin2(digits(e.target.value))} type="password" inputMode="numeric" autoComplete="new-password" placeholder="••••••" className={box} />
                </label>
                <p className="text-xs text-slate-500">{t("vault.setup.note")}</p>
                <button type="submit" disabled={busy || code.length !== 6 || pin.length !== 6 || pin2.length !== 6} className={primary}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} {t("vault.setup.save")}
                </button>
              </form>
            )}
          </div>
        )}

        {step === "key" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendKey();
            }}
            className="space-y-3"
          >
            <p className="text-sm text-slate-300">{t("vault.key.body", { phone: status?.phone_masked ?? "" })}</p>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-300">{t("vault.key.label")}</span>
              <input value={pin} onChange={(e) => setPin(digits(e.target.value))} type="password" inputMode="numeric" autoComplete="current-password" placeholder="••••••" className={box} autoFocus />
            </label>
            <button type="submit" disabled={busy || pin.length !== 6 || (status?.locked_minutes ?? 0) > 0} className={primary}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} {t("vault.key.next")}
            </button>
            <p className="text-center text-xs text-slate-500">{t("vault.forgot")}</p>
          </form>
        )}

        {step === "code" && challenge && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void confirmCode();
            }}
            className="space-y-3"
          >
            <p className="text-sm text-emerald-300">{t("vault.stepup.sent", { phone: challenge.phone_masked })}</p>
            {devCode && (
              <button type="button" onClick={() => setCode(devCode)} className="flex w-full items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                <span>{t("auth.devCode")}</span>
                <span className="font-mono text-lg font-bold tracking-widest">{devCode}</span>
              </button>
            )}
            <input value={code} onChange={(e) => setCode(digits(e.target.value))} inputMode="numeric" autoComplete="one-time-code" placeholder="••••••" aria-label={t("vault.stepup.enter")} className={box} autoFocus />
            <button type="submit" disabled={busy || code.length !== 6} className={primary}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} {t("vault.stepup.confirm")}
            </button>
            <button type="button" onClick={() => setStep("key")} disabled={busy} className="w-full text-xs text-slate-400 underline disabled:opacity-50">
              {t("vault.stepup.resend")}
            </button>
          </form>
        )}

        {error && <p className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</p>}
        <button onClick={onCancel} className="h-11 w-full rounded-xl border border-slate-600 font-semibold">
          {t("vault.stepup.cancel")}
        </button>
      </div>
    </div>
  );
}