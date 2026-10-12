"use client";

import { use, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ChevronRight, Clock, Landmark, Loader2, ShieldCheck, Smartphone, XCircle } from "lucide-react";
import type { PayView } from "@/lib/types";
import type { SettlementKind } from "@/lib/constants";
import { RailBadge } from "@/components/RailBadge";
import { InstitutionBadge } from "@/components/InstitutionBadge";
import { LanguageMenu } from "@/components/LanguageMenu";
import { fmt } from "@/lib/format";
import { useI18n, type Key } from "@/lib/i18n";
import { localizeError } from "@/lib/i18n/errors";

type State =
  | { kind: "loading" }
  | { kind: "ready"; tx: PayView; mode: "simulated" | "live"; resumed: boolean }
  | { kind: "invalid"; reason: Key | string }
  | { kind: "paid"; latency: number | null; tx: PayView };

// What the device remembers about the payer, so returning payers pay in one tap. Stored only on their own phone.
const PHONE_KEY = "2pay:payer-phone";
const METHOD_KEY = "2pay:last-method";

const REASONS = { NOT_FOUND: "pay.reason.NOT_FOUND", MALFORMED: "pay.reason.MALFORMED", EXPIRED: "pay.reason.EXPIRED", USED: "pay.reason.USED" } as const satisfies Record<string, Key>;

function remembered(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export default function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const { t, lang } = useI18n();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState<SettlementKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [phone, setPhone] = useState("");
  const [editingPhone, setEditingPhone] = useState(true);
  const [lastMethod, setLastMethod] = useState<SettlementKind | "">("");
  const [banner, setBanner] = useState<"cancelled" | "errored" | null>(null);
  const leaving = useRef(false);

  useEffect(() => {
    const saved = remembered(PHONE_KEY);
    setPhone(saved);
    setEditingPhone(!saved); // a remembered number is shown as "Paying as …" with a Change link
    const m = remembered(METHOD_KEY);
    if (m === "bank" || m === "wallet") setLastMethod(m);
    const q = new URLSearchParams(window.location.search);
    if (q.get("cancelled")) setBanner("cancelled");
    else if (q.get("error")) setBanner("errored");

    fetch(`/api/pay/${token}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.valid) setState({ kind: "ready", tx: d.tx, mode: d.mode === "live" ? "live" : "simulated", resumed: !!d.resumed });
        else setState({ kind: "invalid", reason: d.reason && d.reason in REASONS ? REASONS[d.reason as keyof typeof REASONS] : (d.error ?? "pay.reason.NOT_FOUND") });
      })
      .catch(() => setState({ kind: "invalid", reason: "common.offline" }));
  }, [token]);

  // The 90s countdown only applies before the payer has been sent to their bank or wallet.
  const expiresAt = state.kind === "ready" && !state.resumed ? state.tx.expires_at : null;
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => {
      const s = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
      setSecondsLeft(s);
      if (s === 0) setState({ kind: "invalid", reason: "pay.reason.EXPIRED" });
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [expiresAt]);

  /** Send the payer to the rail. Try the bank/wallet app first if a deep link is configured, else the web checkout. */
  const handOver = (url: string, appLink?: string) => {
    leaving.current = true;
    if (!appLink) return window.location.assign(url);
    let appOpened = false;
    const onHide = () => {
      if (document.hidden) appOpened = true; // the page went to the background: the app took over
    };
    document.addEventListener("visibilitychange", onHide);
    window.location.href = appLink;
    setTimeout(() => {
      document.removeEventListener("visibilitychange", onHide);
      if (!appOpened && !document.hidden) window.location.assign(url); // no app: continue on the web
    }, 1600);
  };

  /**
   * Tapping a rail starts the payment. Simulated mode authorizes at once; live mode sends the payer to the rail to
   * approve, and the sale only turns paid when the rail confirms. The server derives the institution from the pay node.
   */
  const pay = async (method: SettlementKind) => {
    if (state.kind !== "ready" || busy) return;
    setBusy(method);
    setError(null);
    setBanner(null);
    try {
      try {
        if (phone) localStorage.setItem(PHONE_KEY, phone);
        localStorage.setItem(METHOD_KEY, method);
      } catch {
        /* storage unavailable: it just won't be remembered */
      }
      const res = await fetch(`/api/pay/${token}/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, phone, lang }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t("common.errorGeneric"));
      if (data.mode === "redirect") return handOver(data.url, data.appLink); // keep the buttons locked while handing over
      setState({ kind: "paid", latency: data.latency_ms ?? null, tx: { ...state.tx, rail: data.rail ?? state.tx.rail } });
      setTimeout(() => router.replace(data.next ?? `/pay/${token}/receipt`), 900); // brief confirmation, then the receipt
    } catch (e) {
      setError(localizeError((e as Error).message, t));
      setBusy(null);
    }
  };

  const options =
    state.kind === "ready"
      ? ([
          state.tx.routed_bank && { method: "bank" as const, name: state.tx.routed_bank.institution, hint: t("pay.hint.bank"), Icon: Landmark, tone: "border-sky-500/40 bg-sky-500/10" },
          state.tx.routed_wallet && { method: "wallet" as const, name: state.tx.routed_wallet.institution, hint: t("pay.hint.wallet"), Icon: Smartphone, tone: "border-amber-500/40 bg-amber-500/10" },
        ]
          .filter(Boolean)
          // The method this payer used last time goes first, so a returning payer's thumb is already on it.
          .sort((a, b) => Number(b!.method === lastMethod) - Number(a!.method === lastMethod)) as { method: SettlementKind; name: string; hint: string; Icon: typeof Landmark; tone: string }[])
      : [];

  const showPhoneInput = state.kind === "ready" && options.length > 0;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-5">
      <div className="flex justify-end">
        <LanguageMenu />
      </div>

      {state.kind === "loading" && (
        <div className="flex items-center justify-center gap-2 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" /> {t("pay.verifying")}
        </div>
      )}

      {state.kind === "invalid" && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 p-8 text-center">
          <XCircle className="h-14 w-14 text-rose-400" />
          <h1 className="text-xl font-bold">{t("pay.invalidTitle")}</h1>
          <p className="text-slate-300">{state.reason.includes(".") && !state.reason.includes(" ") ? t(state.reason as Key) : localizeError(state.reason, t)}</p>
        </div>
      )}

      {state.kind === "ready" && (
        <>
          {banner && (
            <div className={`rounded-xl p-3 text-sm ${banner === "cancelled" ? "bg-amber-500/10 text-amber-200" : "bg-rose-500/15 text-rose-300"}`}>
              {banner === "cancelled" ? t("pay.cancelled") : t("pay.errored")}
            </div>
          )}

          <div className="flex items-start gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
            <ShieldCheck className="mt-0.5 h-6 w-6 shrink-0 text-brand" />
            <div className="text-sm">
              <div className="font-semibold text-emerald-300">{t("pay.verified")}</div>
              <div className="text-slate-300">{state.mode === "live" ? t("pay.live") : t("pay.demo")}</div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-center">
            <div className="text-sm text-slate-400">{t("pay.to")}</div>
            <div className="text-xl font-semibold">{state.tx.merchant_name}</div>
            <div className="text-xs text-slate-500">
              {state.tx.merchant_category} · {state.tx.terminal_id}
            </div>
            <div className="mt-5 text-5xl font-bold tabular-nums">
              {fmt(Number(state.tx.amount))}
              <span className="ml-2 text-xl text-slate-400">{state.tx.currency === "ETB" ? t("common.etb") : state.tx.currency}</span>
            </div>
            <div className="mt-1 text-xs uppercase tracking-wide text-slate-500">{t("pay.locked")}</div>
            {state.resumed ? (
              <div className="mt-4 text-sm text-sky-300">{t("pay.inProgress")}</div>
            ) : (
              <div className="mt-4 flex items-center justify-center gap-1 text-sm text-slate-400">
                <Clock className="h-4 w-4" /> {t("pay.remaining", { s: secondsLeft })}
              </div>
            )}
          </div>

          {showPhoneInput &&
            (!editingPhone && phone ? (
              <div className="flex items-center justify-between rounded-xl bg-slate-900 px-4 py-3 text-sm">
                <span className="text-slate-300">{t("pay.phoneRemembered", { phone })}</span>
                <button onClick={() => setEditingPhone(true)} className="font-semibold text-brand underline">
                  {t("pay.change")}
                </button>
              </div>
            ) : (
              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-300">{state.mode === "live" ? t("pay.phone.live") : t("pay.phone.demo")}</span>
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
            ))}

          {options.length > 0 ? (
            <div className="space-y-3">
              <h2 className="text-center text-sm font-medium text-slate-300">{t("pay.choose")}</h2>
              {options.map(({ method, name, hint, Icon, tone }) => (
                <button
                  key={method}
                  onClick={() => pay(method)}
                  disabled={busy !== null}
                  className={`flex w-full items-center gap-4 rounded-2xl border p-4 text-left transition active:scale-[0.99] disabled:opacity-60 ${tone}`}
                >
                  <span className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-950/60">
                    {busy === method ? <Loader2 className="h-6 w-6 animate-spin" /> : <InstitutionBadge name={name} className="h-10 w-10 text-xs" />}
                    <Icon className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full bg-slate-900 p-0.5 text-slate-300" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-lg font-bold text-white">{t("pay.via", { name })}</span>
                    <span className="block text-xs opacity-80">
                      {hint}
                      {lastMethod === method && <span className="ml-2 rounded bg-slate-950/60 px-1.5 py-0.5 text-[10px] uppercase">{t("pay.lastUsed")}</span>}
                    </span>
                  </span>
                  <ChevronRight className="h-5 w-5 shrink-0 opacity-60" />
                </button>
              ))}
              {busy && leaving.current && <p className="text-center text-sm text-slate-400">{t("pay.opening")}</p>}
            </div>
          ) : (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-center text-sm text-amber-200">{t("pay.noMethod")}</div>
          )}

          {error && <div className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</div>}

          <p className="text-center text-xs text-slate-500">{state.mode === "live" ? t("pay.footer.live") : t("pay.footer.demo")}</p>
        </>
      )}

      {state.kind === "paid" && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-8 text-center">
          <CheckCircle2 className="h-16 w-16 text-brand" />
          <h1 className="text-2xl font-bold">{t("pay.paid.title")}</h1>
          <p className="text-slate-300">{t("pay.paid.line", { amount: fmt(Number(state.tx.amount)), currency: state.tx.currency === "ETB" ? t("common.etb") : state.tx.currency, merchant: state.tx.merchant_name })}</p>
          <RailBadge rail={state.tx.rail} />
          {state.latency != null && <p className="text-sm text-slate-400">{t("pay.paid.in", { s: (state.latency / 1000).toFixed(1) })}</p>}
        </div>
      )}
    </main>
  );
}
