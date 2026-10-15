"use client";

import { use, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ChevronRight, Clock, Landmark, Loader2, ShieldCheck, Smartphone, XCircle } from "lucide-react";
import type { PayView } from "@/lib/types";
import type { SettlementKind } from "@/lib/constants";
import { RailBadge } from "@/components/RailBadge";
import { BrandLogo } from "@/components/BrandLogo";
import { hueFor } from "@/lib/constants";
import { LanguageMenu } from "@/components/LanguageMenu";
import { fmt } from "@/lib/format";
import { markChimed, playPaymentChime, preloadAnnouncement, primeAudio } from "@/lib/chime";
import { ALL_PAYER_APPS, POPULAR_PAYER_APPS, type PayerApp } from "@/lib/routing-hub";
import { useI18n, type Key } from "@/lib/i18n";
import { localizeError } from "@/lib/i18n/errors";

type State =
  | { kind: "loading" }
  | { kind: "ready"; tx: PayView; mode: "simulated" | "live"; resumed: boolean; servedBy: { name: string; team_no: string | null } | null }
  | { kind: "invalid"; reason: Key | string }
  | { kind: "paid"; latency: number | null; tx: PayView };

// What the device remembers about the payer, so returning payers pay in one tap. Stored only on their own phone.
const PHONE_KEY = "2pay:payer-phone";
const METHOD_KEY = "2pay:last-method";
const APP_KEY = "2pay:last-app";

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
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [phone, setPhone] = useState("");
  const [editingPhone, setEditingPhone] = useState(true);
  const [lastMethod, setLastMethod] = useState<SettlementKind | "">("");
  const [lastApp, setLastApp] = useState("");
  const [showMore, setShowMore] = useState(false); // the rest of the national list
  const [showOther, setShowOther] = useState(false); // "my app is not listed": the merchant's own two methods
  const [opening, setOpening] = useState<{ app: string; transfer: "internal" | "interbank" | "wallet"; to: string } | null>(null);
  const [banner, setBanner] = useState<"cancelled" | "errored" | null>(null);
  // A tip for the person serving: a percentage of the bill, or any amount the customer types. Zero by default.
  const [tipPct, setTipPct] = useState<0 | 5 | 10 | 15 | "other">(0);
  const [otherTip, setOtherTip] = useState("");
  const leaving = useRef(false);

  useEffect(() => {
    const saved = remembered(PHONE_KEY);
    setPhone(saved);
    setEditingPhone(!saved); // a remembered number is shown as "Paying as …" with a Change link
    setLastApp(remembered(APP_KEY));
    preloadAnnouncement();
    const m = remembered(METHOD_KEY);
    if (m === "bank" || m === "wallet") setLastMethod(m);
    const q = new URLSearchParams(window.location.search);
    if (q.get("cancelled")) setBanner("cancelled");
    else if (q.get("error")) setBanner("errored");

    fetch(`/api/pay/${token}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.valid) setState({ kind: "ready", tx: d.tx, mode: d.mode === "live" ? "live" : "simulated", resumed: !!d.resumed, servedBy: d.served_by ?? null });
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

  const billAmount = state.kind === "ready" ? Number(state.tx.amount) : 0;
  const tipAmount =
    tipPct === "other"
      ? Math.round(Number(otherTip || 0) * 100) / 100
      : Math.round(billAmount * tipPct) / 100; // billAmount * pct / 100, to cents
  const tipValid = Number.isFinite(tipAmount) && tipAmount >= 0 && tipAmount <= Math.min(billAmount, 50000);

  /**
   * Tapping a rail starts the payment. Simulated mode authorizes at once; live mode sends the payer to the rail to
   * approve, and the sale only turns paid when the rail confirms. The server derives the institution from the pay node.
   */
  const pay = async (choice: { method: SettlementKind } | { app: string } | { account: string }) => {
    if (state.kind !== "ready" || busy) return;
    if (!tipValid) return setError(t("crew.pay.tipBad"));
    primeAudio(); // this tap is the browser's permission for sound, so the receipt can chime the moment it appears
    const key = "method" in choice ? choice.method : "account" in choice ? choice.account : choice.app;
    setBusy(key);
    setError(null);
    setBanner(null);
    try {
      try {
        if (phone) localStorage.setItem(PHONE_KEY, phone);
        if ("method" in choice) localStorage.setItem(METHOD_KEY, choice.method);
        else if ("app" in choice) localStorage.setItem(APP_KEY, choice.app);
      } catch {
        /* storage unavailable: it just won't be remembered */
      }
      const res = await fetch(`/api/pay/${token}/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Either the customer's own app (the server picks the merchant's receiving account) or one of the merchant's methods.
        body: JSON.stringify({ ...("method" in choice ? { method: choice.method } : "account" in choice ? { account_id: choice.account } : { payer_app: choice.app }), phone, lang, ...(tipAmount > 0 && !state.resumed ? { tip: tipAmount } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t("common.errorGeneric"));
      if (data.mode === "redirect") {
        // Say which screen of their own app is opening (same bank, or "transfer to other banks" with the merchant's bank chosen).
        if (data.appLink && "app" in choice && data.transfer) setOpening({ app: choice.app, transfer: data.transfer, to: data.to });
        return handOver(data.url, data.appLink); // keep the buttons locked while handing over
      }
      // The payment has cleared: the chime sounds NOW (the word follows with the receipt on the next screen).
      playPaymentChime();
      markChimed(token);
      setState({ kind: "paid", latency: data.latency_ms ?? null, tx: { ...state.tx, rail: data.rail ?? state.tx.rail } });
      setTimeout(() => router.replace(data.next ?? `/pay/${token}/receipt`), 450); // a brief confirmation, then the receipt
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
            {state.servedBy && (
              <div className="mt-3 inline-flex items-center rounded-full bg-slate-800 px-3 py-1 text-sm text-slate-200">
                {t("crew.pay.served", { name: state.servedBy.name })}
                {state.servedBy.team_no && <span className="ml-2 font-mono text-xs text-slate-400">{state.servedBy.team_no}</span>}
              </div>
            )}
            {state.resumed ? (
              <div className="mt-4 text-sm text-sky-300">{t("pay.inProgress")}</div>
            ) : (
              <div className="mt-4 flex items-center justify-center gap-1 text-sm text-slate-400">
                <Clock className="h-4 w-4" /> {t("pay.remaining", { s: secondsLeft })}
              </div>
            )}
          </div>

          {state.servedBy && !state.resumed && (
            <div className="space-y-2 rounded-2xl border border-slate-800 bg-slate-900 p-4">
              <h2 className="text-sm font-medium text-slate-300">{t("crew.pay.tipTitle", { name: state.servedBy.name })}</h2>
              <div className="grid grid-cols-5 gap-2 text-sm font-semibold">
                {([0, 5, 10, 15, "other"] as const).map((p) => (
                  <button
                    key={String(p)}
                    type="button"
                    onClick={() => setTipPct(p)}
                    aria-pressed={tipPct === p}
                    className={`rounded-xl border px-1 py-2.5 ${tipPct === p ? "border-brand bg-brand/10 text-white" : "border-slate-700 text-slate-300"}`}
                  >
                    {p === 0 ? t("crew.pay.noTip") : p === "other" ? t("crew.pay.other") : `${p}%`}
                  </button>
                ))}
              </div>
              {tipPct === "other" && (
                <input
                  value={otherTip}
                  onChange={(e) => setOtherTip(e.target.value.replace(/[^0-9.]/g, ""))}
                  inputMode="decimal"
                  placeholder={t("crew.pay.otherPh")}
                  className="h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-lg text-slate-100 placeholder:text-slate-600 focus:border-brand focus:outline-none"
                />
              )}
              {tipAmount > 0 && tipValid && (
                <p className="text-center text-sm font-semibold text-brand">
                  {t("crew.pay.total", { total: fmt(billAmount + tipAmount), currency: state.tx.currency === "ETB" ? t("common.etb") : state.tx.currency, bill: fmt(billAmount), tip: fmt(tipAmount) })}
                </p>
              )}
              {!tipValid && <p className="text-center text-sm text-rose-300">{t("crew.pay.tipBad")}</p>}
            </div>
          )}

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

          {options.length > 0 && !state.resumed && (
            <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-4" aria-labelledby="hub-title">
              <div>
                <h2 id="hub-title" className="text-base font-bold text-white">{t("hub.title")}</h2>
                <p className="text-xs text-slate-400">{t("hub.sub")}</p>
              </div>
              {(["wallet", "bank"] as const).map((kind) => {
                const list = (showMore ? ALL_PAYER_APPS : POPULAR_PAYER_APPS).filter((a) => a.kind === kind);
                return (
                  <div key={kind} className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t(kind === "wallet" ? "hub.wallets" : "hub.banks")}</h3>
                    <div className="grid grid-cols-3 gap-2">
                      {list.map((a: PayerApp) => (
                        <button
                          key={a.name}
                          type="button"
                          onClick={() => pay({ app: a.name })}
                          disabled={busy !== null}
                          aria-label={t("pay.via", { name: a.name })}
                          style={lastApp === a.name ? undefined : { borderColor: `hsl(${hueFor(a.name)} 45% 42% / 0.55)`, background: `hsl(${hueFor(a.name)} 45% 30% / 0.14)` }}
                          className={`relative flex flex-col items-center gap-1.5 rounded-xl border px-1 py-3 text-center shadow-sm transition active:scale-95 disabled:opacity-60 ${lastApp === a.name ? "border-brand bg-brand/10" : ""}`}
                        >
                          {busy === a.name ? <Loader2 className="h-10 w-10 animate-spin" /> : <BrandLogo name={a.name} className="h-10 w-10 text-xs" />}
                          <span className="line-clamp-2 min-h-[2rem] text-[11px] font-medium leading-4 text-slate-200">{a.name.replace(/ \([A-Z]+\)$/, "")}</span>
                          {lastApp === a.name && <span className="absolute -top-1.5 right-1 rounded bg-brand px-1.5 text-[9px] font-bold uppercase text-slate-950">{t("hub.last")}</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
              <div className="flex items-center justify-between text-xs">
                <button type="button" onClick={() => setShowMore((v) => !v)} className="font-semibold text-brand underline">
                  {t(showMore ? "hub.less" : "hub.more")}
                </button>
                <button type="button" onClick={() => setShowOther((v) => !v)} className="text-slate-400 underline">
                  {t("hub.other")}
                </button>
              </div>
              {state.kind === "ready" && state.tx.payee_options && state.tx.payee_options.length > 0 && (
                <div className="space-y-2 border-t border-slate-800 pt-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("hub.driverAccounts")}</h3>
                  {state.tx.payee_options.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => pay({ account: o.id })}
                      disabled={busy !== null}
                      style={{ borderColor: `hsl(${hueFor(o.institution)} 50% 45% / 0.6)`, background: `hsl(${hueFor(o.institution)} 50% 32% / 0.16)` }}
                      className="flex w-full items-center gap-3 rounded-xl border p-3 text-left shadow-sm transition active:scale-[0.99] disabled:opacity-60"
                    >
                      {busy === o.id ? <Loader2 className="h-10 w-10 animate-spin" /> : <BrandLogo name={o.institution} className="h-10 w-10 text-xs" />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-bold text-white">{o.institution}</span>
                        <span className="block font-mono text-xs text-slate-300">{o.account_masked}</span>
                      </span>
                      <ChevronRight className="h-5 w-5 shrink-0 opacity-60" />
                    </button>
                  ))}
                </div>
              )}
              {opening && <p className="rounded-lg bg-brand/10 p-2 text-center text-xs font-medium text-emerald-200">{t(`hub.open.${opening.transfer}` as Key, { app: opening.app, to: opening.to })}</p>}
              {busy && busy !== "bank" && busy !== "wallet" && !opening && <p className="text-center text-xs text-slate-400">{t("hub.opening", { name: busy })}</p>}
            </section>
          )}

          {options.length > 0 && (state.resumed || showOther) ? (
            <div className="space-y-3">
              <h2 className="text-center text-sm font-medium text-slate-300">{showOther && !state.resumed ? t("hub.otherHelp") : t("pay.choose")}</h2>
              {options.map(({ method, name, hint, Icon, tone }) => (
                <button
                  key={method}
                  onClick={() => pay({ method })}
                  disabled={busy !== null}
                  style={{ borderColor: `hsl(${hueFor(name)} 50% 45% / 0.6)`, background: `hsl(${hueFor(name)} 50% 32% / 0.16)` }}
                  className={`flex w-full items-center gap-4 rounded-2xl border p-4 text-left shadow-md transition active:scale-[0.99] disabled:opacity-60`}
                >
                  <span className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-950/60">
                    {busy === method ? <Loader2 className="h-6 w-6 animate-spin" /> : <BrandLogo name={name} className="h-10 w-10 text-xs" />}
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
          ) : options.length === 0 ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-center text-sm text-amber-200">{t("pay.noMethod")}</div>
          ) : null}

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
