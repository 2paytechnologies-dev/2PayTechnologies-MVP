"use client";

import { use, useEffect, useState } from "react";
import { CheckCircle2, Clock, Fingerprint, Loader2, ShieldCheck, XCircle } from "lucide-react";
import type { PayView, Rail } from "@/lib/types";
import { RAILS } from "@/lib/types";
import { RailBadge } from "@/components/RailBadge";

type State =
  | { kind: "loading" }
  | { kind: "ready"; tx: PayView }
  | { kind: "invalid"; reason: string }
  | { kind: "paid"; latency: number; tx: PayView };

const reasonText: Record<string, string> = {
  NOT_FOUND: "This pay node does not exist.",
  MALFORMED: "This pay link is malformed.",
  EXPIRED: "This pay node has expired. Ask the cashier to generate a new one.",
  USED: "This pay node has already been used.",
};

export default function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [rail, setRail] = useState<Rail>("EthioPay-IPS");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    fetch(`/api/pay/${token}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.valid) setState({ kind: "ready", tx: d.tx });
        else setState({ kind: "invalid", reason: reasonText[d.reason] ?? d.error ?? "Invalid pay node." });
      })
      .catch(() => setState({ kind: "invalid", reason: "Cannot reach 2Pay." }));
  }, [token]);

  const expiresAt = state.kind === "ready" ? state.tx.expires_at : null;
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => {
      const s = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
      setSecondsLeft(s);
      if (s === 0) setState({ kind: "invalid", reason: reasonText.EXPIRED });
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [expiresAt]);

  const authorize = async () => {
    if (state.kind !== "ready") return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/pay/${token}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rail }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Authorization failed");
      setState({ kind: "paid", latency: data.latency_ms, tx: { ...state.tx, rail } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-5">
      {state.kind === "loading" && (
        <div className="flex items-center justify-center gap-2 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" /> Verifying token…
        </div>
      )}

      {state.kind === "invalid" && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 p-8 text-center">
          <XCircle className="h-14 w-14 text-rose-400" />
          <h1 className="text-xl font-bold">Cannot authorize</h1>
          <p className="text-slate-300">{state.reason}</p>
        </div>
      )}

      {state.kind === "ready" && (
        <>
          <div className="flex items-start gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
            <ShieldCheck className="mt-0.5 h-6 w-6 shrink-0 text-brand" />
            <div className="text-sm">
              <div className="font-semibold text-emerald-300">Verified 2Pay Orchestration</div>
              <div className="text-slate-300">→ Settling via Arifpay Rails</div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-center">
            <div className="text-sm text-slate-400">Pay to</div>
            <div className="text-xl font-semibold">{state.tx.merchant_name}</div>
            <div className="text-xs text-slate-500">
              {state.tx.merchant_category} · {state.tx.terminal_id}
            </div>
            <div className="mt-5 text-5xl font-bold tabular-nums">
              {state.tx.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
              <span className="ml-2 text-xl text-slate-400">{state.tx.currency}</span>
            </div>
            <div className="mt-1 text-xs uppercase tracking-wide text-slate-500">Amount locked</div>
            <div className="mt-4 flex items-center justify-center gap-1 text-sm text-slate-400">
              <Clock className="h-4 w-4" /> {secondsLeft}s remaining
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {RAILS.map((r) => (
              <button
                key={r}
                onClick={() => setRail(r)}
                className={`rounded-xl border p-2 text-xs font-medium ${
                  rail === r ? "border-brand bg-brand/10 text-white" : "border-slate-800 bg-slate-900 text-slate-400"
                }`}
              >
                {r}
              </button>
            ))}
          </div>

          {error && <div className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</div>}

          <button
            onClick={authorize}
            disabled={busy}
            className="flex items-center justify-center gap-2 rounded-2xl bg-brand py-5 text-lg font-bold text-slate-950 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <Fingerprint className="h-6 w-6" />}
            Authorize with Biometrics / PIN
          </button>
          <p className="text-center text-xs text-slate-500">
            Simulated inherited authorization from your wallet. 2Pay never holds your funds.
          </p>
        </>
      )}

      {state.kind === "paid" && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-8 text-center">
          <CheckCircle2 className="h-16 w-16 text-brand" />
          <h1 className="text-2xl font-bold">Payment authorized</h1>
          <p className="text-slate-300">
            {state.tx.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })} {state.tx.currency} to{" "}
            {state.tx.merchant_name}
          </p>
          <RailBadge rail={state.tx.rail} />
          <p className="text-sm text-slate-400">Completed in {(state.latency / 1000).toFixed(1)}s</p>
        </div>
      )}
    </main>
  );
}
