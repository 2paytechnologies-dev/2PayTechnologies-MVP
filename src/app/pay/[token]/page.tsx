"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ChevronRight, Clock, Landmark, Loader2, ShieldCheck, Smartphone, XCircle } from "lucide-react";
import type { PayView } from "@/lib/types";
import type { SettlementKind } from "@/lib/constants";
import { RailBadge } from "@/components/RailBadge";

type State =
  | { kind: "loading" }
  | { kind: "ready"; tx: PayView; mode: "simulated" | "live"; resumed: boolean }
  | { kind: "invalid"; reason: string }
  | { kind: "paid"; latency: number | null; tx: PayView };

const PHONE_KEY = "2pay:payer-phone";

const reasonText: Record<string, string> = {
  NOT_FOUND: "This pay node does not exist.",
  MALFORMED: "This pay link is malformed.",
  EXPIRED: "This pay node has expired. Ask the cashier to generate a new one.",
  USED: "This pay node has already been used.",
};

export default function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState<SettlementKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [phone, setPhone] = useState("");

  useEffect(() => {
    try {
      setPhone(localStorage.getItem(PHONE_KEY) ?? "");
    } catch {
      /* storage unavailable */
    }
    fetch(`/api/pay/${token}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.valid) setState({ kind: "ready", tx: d.tx, mode: d.mode === "live" ? "live" : "simulated", resumed: !!d.resumed });
        else setState({ kind: "invalid", reason: reasonText[d.reason] ?? d.error ?? "Invalid pay node." });
      })
      .catch(() => setState({ kind: "invalid", reason: "Cannot reach 2Pay." }));
  }, [token]);

  // The 90s countdown only applies before the payer has been sent to their bank or wallet.
  const expiresAt = state.kind === "ready" && !state.resumed ? state.tx.expires_at : null;
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

  /**
   * Tapping a rail starts the payment. Simulated mode authorizes at once; live mode sends the payer to the rail to
   * approve, and the sale only turns paid when the rail confirms. The server derives the institution from the pay node.
   */
  const pay = async (method: SettlementKind) => {
    if (state.kind !== "ready" || busy) return;
    setBusy(method);
    setError(null);
    try {
      if (state.mode === "live") {
        try {
          localStorage.setItem(PHONE_KEY, phone);
        } catch {
          /* storage unavailable */
        }
      }
      const res = await fetch(`/api/pay/${token}/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, phone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not start the payment");
      if (data.mode === "redirect") {
        window.location.assign(data.url); // hand over to the bank / wallet; leave the buttons locked meanwhile
        return;
      }
      setState({ kind: "paid", latency: data.latency_ms ?? null, tx: { ...state.tx, rail: data.rail ?? state.tx.rail } });
      setTimeout(() => router.replace(data.next ?? `/pay/${token}/receipt`), 900); // brief confirmation, then the receipt
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const options =
    state.kind === "ready"
      ? ([
          state.tx.routed_bank && { method: "bank" as const, name: state.tx.routed_bank.institution, hint: "Bank transfer", Icon: Landmark, tone: "border-sky-500/40 bg-sky-500/10 text-sky-300" },
          state.tx.routed_wallet && { method: "wallet" as const, name: state.tx.routed_wallet.institution, hint: "Mobile wallet", Icon: Smartphone, tone: "border-amber-500/40 bg-amber-500/10 text-amber-300" },
        ].filter(Boolean) as { method: SettlementKind; name: string; hint: string; Icon: typeof Landmark; tone: string }[])
      : [];

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
              <div className="text-slate-300">
                {state.mode === "live" ? "→ You'll approve in your own bank or wallet" : "→ Demo mode: no real money moves"}
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-center">
            <div className="text-sm text-slate-400">Pay to</div>
            <div className="text-xl font-semibold">{state.tx.merchant_name}</div>
            <div className="text-xs text-slate-500">
              {state.tx.merchant_category} · {state.tx.terminal_id}
            </div>
            <div className="mt-5 text-5xl font-bold tabular-nums">
              {Number(state.tx.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}
              <span className="ml-2 text-xl text-slate-400">{state.tx.currency}</span>
            </div>
            <div className="mt-1 text-xs uppercase tracking-wide text-slate-500">Amount locked</div>
            {state.resumed ? (
              <div className="mt-4 text-sm text-sky-300">Payment in progress. You can pick up where you left off.</div>
            ) : (
              <div className="mt-4 flex items-center justify-center gap-1 text-sm text-slate-400">
                <Clock className="h-4 w-4" /> {secondsLeft}s remaining
              </div>
            )}
          </div>

          {state.mode === "live" && options.length > 0 && (
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-300">Mobile number of the account you are paying from</span>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="tel"
                autoComplete="tel"
                placeholder="0911 223 344"
                maxLength={20}
                className="h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-lg text-slate-100 placeholder:text-slate-600 focus:border-brand focus:outline-none"
              />
            </label>
          )}

          {options.length > 0 ? (
            <div className="space-y-3">
              <h2 className="text-center text-sm font-medium text-slate-300">Choose how you want to pay</h2>
              {options.map(({ method, name, hint, Icon, tone }) => (
                <button
                  key={method}
                  onClick={() => pay(method)}
                  disabled={busy !== null}
                  className={`flex w-full items-center gap-4 rounded-2xl border p-4 text-left transition active:scale-[0.99] disabled:opacity-60 ${tone}`}
                >
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-950/60">
                    {busy === method ? <Loader2 className="h-6 w-6 animate-spin" /> : <Icon className="h-6 w-6" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-lg font-bold text-white">Pay via {name}</span>
                    <span className="block text-xs opacity-80">{hint}</span>
                  </span>
                  <ChevronRight className="h-5 w-5 shrink-0 opacity-60" />
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-center text-sm text-amber-200">
              This merchant has no payment method set up yet. Please ask the cashier to generate a new pay node.
            </div>
          )}

          {error && <div className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</div>}

          <p className="text-center text-xs text-slate-500">
            {state.mode === "live"
              ? "You approve the payment with your own bank or wallet. 2Pay never sees your PIN and never holds your funds."
              : "Simulated authorization for demonstration. No real payment is made."}
          </p>
        </>
      )}

      {state.kind === "paid" && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-8 text-center">
          <CheckCircle2 className="h-16 w-16 text-brand" />
          <h1 className="text-2xl font-bold">Payment authorized</h1>
          <p className="text-slate-300">
            {Number(state.tx.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })} {state.tx.currency} to {state.tx.merchant_name}
          </p>
          <RailBadge rail={state.tx.rail} />
          {state.latency != null && <p className="text-sm text-slate-400">Completed in {(state.latency / 1000).toFixed(1)}s</p>}
        </div>
      )}
    </main>
  );
}
