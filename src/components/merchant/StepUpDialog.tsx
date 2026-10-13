"use client";

import { useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { useT } from "@/lib/i18n";
import { requestStepUp, verifyStepUp } from "@/lib/settlement-client";

/**
 * "Confirm it's you": before the receiving account is changed, the owner enters a one-time code that was sent only to the
 * phone registered to the business. Shown automatically when the server asks for it; the change then goes through.
 */
export function StepUpDialog({ merchantId, onVerified, onCancel }: { merchantId: string; onVerified: () => void; onCancel: () => void }) {
  const t = useT();
  const [challenge, setChallenge] = useState<{ id: string; phone: string; devCode?: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await requestStepUp(merchantId);
      setChallenge({ id: r.challengeId, phone: r.phoneMasked, devCode: r.devCode });
      setCode("");
    } catch (e) {
      setError((e as Error).message === "request" ? t("common.errorGeneric") : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      await verifyStepUp(merchantId, challenge.id, code);
      onVerified();
    } catch (err) {
      setError((err as Error).message === "verify" ? t("common.errorGeneric") : (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5" role="dialog" aria-modal="true" aria-labelledby="stepup-title">
      <div className="w-full max-w-sm space-y-4 rounded-2xl border border-slate-700 bg-slate-900 p-5">
        <h3 id="stepup-title" className="flex items-center gap-2 text-lg font-bold">
          <ShieldCheck className="h-5 w-5 text-brand" /> {t("vault.stepup.title")}
        </h3>
        <p className="text-sm text-slate-300">{t("vault.stepup.body")}</p>

        {!challenge ? (
          <button onClick={send} disabled={busy} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand font-bold text-slate-950 disabled:opacity-50">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("vault.stepup.send")}
          </button>
        ) : (
          <form onSubmit={confirm} className="space-y-3">
            <p className="text-sm text-emerald-300">{t("vault.stepup.sent", { phone: challenge.phone })}</p>
            {challenge.devCode && (
              <button type="button" onClick={() => setCode(challenge.devCode!)} className="flex w-full items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                <span>{t("auth.devCode")}</span>
                <span className="font-mono text-lg font-bold tracking-widest">{challenge.devCode}</span>
              </button>
            )}
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="••••••"
              aria-label={t("vault.stepup.enter")}
              className="h-14 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-center font-mono text-2xl tracking-[0.5em] focus:border-brand focus:outline-none"
              autoFocus
            />
            <button type="submit" disabled={busy || code.length !== 6} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand font-bold text-slate-950 disabled:opacity-50">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} {t("vault.stepup.confirm")}
            </button>
            <button type="button" onClick={send} disabled={busy} className="w-full text-xs text-slate-400 underline disabled:opacity-50">
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