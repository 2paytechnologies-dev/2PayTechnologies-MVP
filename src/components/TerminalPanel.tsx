"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import Link from "next/link";
import { Check, CheckCircle2, Copy, Delete, Loader2, Nfc, QrCode, RefreshCw, RotateCcw, Route, ScanLine, TriangleAlert } from "lucide-react";
import { isPaid, type Transaction } from "@/lib/types";
import { primeAudio, keepAudioAlive, playSettlementChime } from "@/lib/chime";
import { clearPayLink, keepScreenAwake, nativeInfo, presentPayLink, type NativeInfo } from "@/lib/native";
import { eatDateKey, eatDayStartISO, fmt } from "@/lib/format";
import { useI18n, useT, type Key } from "@/lib/i18n";

const PRESETS = [100, 500, 1000];
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"];

/** The server issues pay nodes with a 90s TTL. The QR is swapped for a fresh node this long before expiry. */
const NODE_TTL_S = 90;
const REFRESH_LEAD_S = 20;
/** Auto-refresh stops after this many swaps (~10 minutes) so an abandoned screen doesn't mint nodes forever. */
const MAX_ROTATIONS = 8;
const RETRY_MS = 4000;

type NfcState =
  | { kind: "idle" }
  | { kind: "unsupported" }
  | { kind: "waiting" }
  | { kind: "written" }
  | { kind: "blocked" }
  | { kind: "failed"; message: string };

interface Props {
  merchantId: string;
  merchantName?: string;
  category?: string;
  /** Active settlement institutions for this merchant (undefined = unknown; the server re-checks on create). */
  routing?: { bank: string | null; wallet: string | null };
  /** Fires true while a pay node is live, so the host can lock its merchant picker. */
  onActiveChange?: (active: boolean) => void;
  /** Called when the cashier taps the "no payment account yet" notice (owner only). */
  onNeedSetup?: () => void;
}

const msLeft = (iso: string) => new Date(iso).getTime() - Date.now();

/**
 * Cashier keypad -> single-use pay node. Two ways to reach the payer, always both:
 *  - Tap: in the Android app this phone itself acts as an NFC tag (Host Card Emulation) carrying the pay link, so a
 *    customer just holds their phone to the back of this one. In Chrome on Android it writes a tag with Web NFC.
 *  - Dynamic QR (always shown, works on any camera): it refreshes itself, so the cashier never has to touch the
 *    screen while waiting. Each QR is a fresh single-use node; the previous one stays valid for its last seconds so
 *    a customer who is mid-scan is not cut off, and any of them being paid completes the sale. In the app, the
 *    tap payload follows the QR, so a tap and a scan always carry the same, current link.
 * Payments that arrive without a cashier sale (customers scanning the printed shop QR) appear in the live feed.
 */
export function TerminalPanel({ merchantId, merchantName, category, routing, onActiveChange, onNeedSetup }: Props) {
  const t = useT();
  const [amount, setAmount] = useState("");
  const [tx, setTx] = useState<Transaction | null>(null); // the node whose QR is on screen
  const [nodes, setNodes] = useState<Transaction[]>([]); // every node that may still be paid
  const [rotations, setRotations] = useState(0);
  const [paused, setPaused] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [done, setDone] = useState<Transaction | null>(null);
  const [nfc, setNfc] = useState<NfcState>({ kind: "idle" });
  const [native, setNative] = useState<NativeInfo | null>(null); // set only inside the Android app
  const [tapped, setTapped] = useState(false); // a customer's phone has just read our tag
  const [processing, setProcessing] = useState(false); // a customer is completing payment at the rail
  const [recent, setRecent] = useState<Transaction[]>([]);
  const [toast, setToast] = useState<Transaction | null>(null);
  const toneFired = useRef(false);
  const nfcAbort = useRef<AbortController | null>(null);
  const tokens = useRef<Set<string>>(new Set());
  const rotationsRef = useRef(0);
  const seenPaid = useRef<Set<string> | null>(null); // ids of paid sales already announced
  const { lang } = useI18n();
  const langRef = useRef(lang); // the announcement is spoken in the language the merchant is using
  useEffect(() => {
    langRef.current = lang;
  }, [lang]);

  useEffect(() => {
    tokens.current = new Set(nodes.map((n) => n.token));
  }, [nodes]);

  /** Create a pay node (used for the first QR and every refresh). */
  const createNode = useCallback(
    async (value: number): Promise<Transaction> => {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchant_id: merchantId, amount: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to create pay node");
      return data as Transaction;
    },
    [merchantId],
  );

  /** Remove a retired node. The server only deletes a node that is still PENDING and that no payer has opened. */
  const cancelNode = useCallback((token: string) => {
    fetch("/api/transactions/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      keepalive: true,
    }).catch(() => {});
  }, []);

  const finish = useCallback(
    (paid: Transaction) => {
      seenPaid.current?.add(paid.id); // this sale is announced by the full-screen result, not again by the feed
      // Chime first, right here, in the same moment the result is shown (not inside the state update, which React may run later).
      if (!toneFired.current) {
        toneFired.current = true;
        playSettlementChime(langRef.current);
      }
      setDone((prev) => {
        if (prev) return prev;
        tokens.current.forEach((tok) => tok !== paid.token && cancelNode(tok)); // the sale is settled; retire the other QRs
        return paid;
      });
    },
    [cancelNode],
  );

  // Payment detection over ALL live nodes, by polling the status API every 0.6s (no database credentials in the browser).
  const listening = !!tx && !done;
  useEffect(() => {
    if (!listening) return;
    let stopped = false;
    let inFlight = false; // a slow answer must not pile up more requests behind it
    const poll = setInterval(async () => {
      keepAudioAlive();
      const list = [...tokens.current];
      if (!list.length || inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/transactions/status?tokens=${list.join(",")}`, { cache: "no-store" });
        if (!res.ok || stopped) return;
        const rows = (await res.json()) as Transaction[];
        const paid = rows.find((r) => isPaid(r.status));
        if (paid) return finish(paid);
        setProcessing(rows.some((r) => r.status === "PROCESSING"));
      } catch {
        /* transient network error: the next poll retries */
      } finally {
        inFlight = false;
      }
    }, 600);
    return () => {
      stopped = true;
      clearInterval(poll);
    };
  }, [listening, finish]);

  // Live feed of today's paid sales. Catches payments that did not start at this keypad (a customer scanning the printed
  // shop QR), announcing each new one with the chime. The first load only records what is already there.
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const from = eatDayStartISO(eatDateKey(new Date()));
        const to = new Date(Date.now() + 86_400_000).toISOString();
        const res = await fetch(`/api/transactions?${new URLSearchParams({ merchant_id: merchantId, from, to, limit: "30" })}`, { cache: "no-store" });
        if (!res.ok || stopped) return;
        const rows = ((await res.json()).rows as Transaction[]).filter((r) => isPaid(r.status));
        if (seenPaid.current === null) {
          seenPaid.current = new Set(rows.map((r) => r.id));
        } else {
          const fresh = rows.filter((r) => !seenPaid.current!.has(r.id));
          fresh.forEach((r) => seenPaid.current!.add(r.id));
          if (fresh.length) {
            playSettlementChime(langRef.current);
            setToast(fresh[0]);
            setTimeout(() => setToast(null), 7000);
          }
        }
        setRecent(rows.slice(0, 5));
      } catch {
        /* the feed is a convenience; the sale flow does not depend on it */
      }
    };
    void load();
    const id = setInterval(load, 2000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [merchantId]);

  // Android app: learn the NFC state, refresh it when the cashier returns from Settings, and hear customer taps.
  useEffect(() => {
    const refresh = () => setNative(nativeInfo());
    refresh();
    const onTap = () => setTapped(true);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("twopay:tap", onTap);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("twopay:tap", onTap);
    };
  }, []);

  // While a sale is waiting, keep the screen on (tag emulation needs it) and present the CURRENT pay link to taps.
  const nfcReady = native?.nfc === "READY";
  const inApp = !!native; // a stable boolean: `native` itself is a fresh object on every refresh
  useEffect(() => {
    if (!listening || !inApp) return;
    keepScreenAwake(true);
    return () => {
      keepScreenAwake(false);
      clearPayLink();
    };
  }, [listening, inApp]);
  const currentToken = tx?.token;
  useEffect(() => {
    if (listening && nfcReady && currentToken) presentPayLink(`${window.location.origin}/pay/${currentToken}`);
  }, [listening, nfcReady, currentToken]);

  // Clock for the countdown / expiry display
  useEffect(() => {
    if (!listening) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [listening]);

  /** Swap in a fresh node. Returns false on failure (the old QR keeps working until it expires). */
  const rotate = useCallback(
    async (current: Transaction, manual = false): Promise<boolean> => {
      setRefreshing(true);
      try {
        const next = await createNode(Number(current.amount));
        rotationsRef.current = manual ? 0 : rotationsRef.current + 1;
        setRotations(rotationsRef.current);
        setNodes((prev) => [...prev.filter((n) => msLeft(n.expires_at) > 0), next]);
        setTx(next);
        setPaused(false);
        setRefreshFailed(false);
        setNow(Date.now());
        setTimeout(() => cancelNode(current.token), Math.max(0, msLeft(current.expires_at)) + 1000); // tidy up if never opened
        return true;
      } catch {
        setRefreshFailed(true);
        return false;
      } finally {
        setRefreshing(false);
      }
    },
    [createNode, cancelNode],
  );

  // Automatic refresh: swap the QR REFRESH_LEAD_S before the current node expires; retry quickly if that fails.
  useEffect(() => {
    if (!tx || done || paused || processing) return; // never swap the code under a customer who is mid-payment
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = async () => {
      if (cancelled) return;
      if (rotationsRef.current >= MAX_ROTATIONS) return setPaused(true);
      const ok = await rotate(tx);
      if (!ok && !cancelled) timer = setTimeout(attempt, RETRY_MS);
    };
    timer = setTimeout(attempt, Math.max(0, msLeft(tx.expires_at) - REFRESH_LEAD_S * 1000));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tx, done, paused, processing, rotate]);

  // Leaving the screen mid-sale retires any unopened nodes.
  useEffect(
    () => () => {
      nfcAbort.current?.abort();
      tokens.current.forEach(cancelNode);
    },
    [cancelNode],
  );

  const active = !!tx;
  useEffect(() => {
    onActiveChange?.(active);
    return () => onActiveChange?.(false);
  }, [active, onActiveChange]);

  const press = (k: string) => {
    setAmount((a) => {
      if (k === "⌫") return a.slice(0, -1);
      if (k === ".") return a.includes(".") || a === "" ? (a === "" ? "0." : a) : a + ".";
      if (a.includes(".") && a.split(".")[1].length >= 2) return a;
      if (a.length >= 8) return a;
      return a === "0" ? k : a + k;
    });
  };

  const stopNfc = () => {
    nfcAbort.current?.abort();
    nfcAbort.current = null;
  };

  const reset = (cancelLive = false) => {
    stopNfc();
    if (cancelLive) tokens.current.forEach(cancelNode);
    setTx(null);
    setNodes([]);
    setDone(null);
    setAmount("");
    setCopied(false);
    setNfc({ kind: "idle" });
    setPaused(false);
    setRefreshFailed(false);
    setRotations(0);
    setTapped(false);
    setProcessing(false);
    rotationsRef.current = 0;
    toneFired.current = false;
  };

  /** Write the pay URL to a tag. Must be invoked from (or shortly after) a user gesture. */
  const writeNfc = useCallback(async (url: string) => {
    if (typeof window === "undefined" || !("NDEFReader" in window)) {
      setNfc({ kind: "unsupported" });
      return;
    }
    stopNfc();
    const ctrl = new AbortController();
    nfcAbort.current = ctrl;
    setNfc({ kind: "waiting" });
    try {
      await new NDEFReader().write({ records: [{ recordType: "url", data: url }] }, { signal: ctrl.signal, overwrite: true });
      setNfc({ kind: "written" });
    } catch (e) {
      const name = (e as DOMException).name;
      if (name === "AbortError") return;
      if (name === "NotAllowedError") setNfc({ kind: "blocked" });
      else if (name === "NotSupportedError") setNfc({ kind: "unsupported" });
      else setNfc({ kind: "failed", message: (e as Error).message });
    }
  }, []);

  const generate = async () => {
    primeAudio();
    setBusy(true);
    setError(null);
    try {
      const data = await createNode(Number(amount));
      rotationsRef.current = 0;
      setRotations(0);
      setPaused(false);
      setRefreshFailed(false);
      setNow(Date.now());
      setNodes([data]);
      setTx(data);
      setTapped(false);
      setProcessing(false);
      // In the app the tap payload is presented by an effect (and follows every QR refresh); Web NFC is the browser path.
      if (!native) void writeNfc(`${window.location.origin}/pay/${data.token}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const payUrl = tx ? `${window.location.origin}/pay/${tx.token}` : "";
  const copy = async () => {
    await navigator.clipboard.writeText(payUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const secondsLeft = tx ? Math.max(0, Math.ceil((new Date(tx.expires_at).getTime() - now) / 1000)) : 0;
  const refreshIn = Math.max(0, secondsLeft - REFRESH_LEAD_S);
  const expired = !!tx && !done && secondsLeft === 0;
  const amountNum = Number(amount);
  const noRouting = !!routing && !routing.bank && !routing.wallet;
  const routingLabel = routing ? [routing.bank, routing.wallet].filter(Boolean).join(" • ") : "";
  const txRoutingLabel = tx ? [tx.routed_bank?.institution, tx.routed_wallet?.institution].filter(Boolean).join(" • ") : "";
  const etb = t("common.etb");

  if (done) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-emerald-500 p-6 text-center text-white">
        <CheckCircle2 className="mb-6 h-32 w-32" strokeWidth={1.5} />
        <h1 className="text-5xl font-extrabold">{t("terminal.done.title")}</h1>
        <p className="mt-2 text-3xl font-bold">ተከፍሏል</p>
        <p className="mt-4 text-6xl font-black">
          {fmt(Number(done.amount))} {done.currency === "ETB" ? etb : done.currency}
        </p>
        <p className="mt-6 text-2xl font-semibold">
          {done.latency_ms != null ? t("terminal.done.authorized", { s: (done.latency_ms / 1000).toFixed(1), rail: done.rail }) : t("terminal.done.paidVia", { rail: done.rail })}
        </p>
        <p className="mt-1 text-emerald-100">{merchantName}</p>
        <button onClick={() => reset()} className="mt-10 inline-flex items-center gap-2 rounded-2xl bg-white px-8 py-4 text-lg font-bold text-emerald-700">
          <RotateCcw className="h-5 w-5" /> {t("terminal.done.newSale")}
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4" onPointerDownCapture={primeAudio}>
      {toast && (
        <div className="fixed inset-x-4 top-4 z-40 mx-auto flex max-w-md items-center gap-3 rounded-2xl bg-emerald-500 p-4 text-white shadow-2xl" role="status">
          <CheckCircle2 className="h-8 w-8 shrink-0" />
          <div>
            <div className="font-bold">{t("terminal.recent.toast", { amount: fmt(Number(toast.amount)), currency: toast.currency === "ETB" ? etb : toast.currency })}</div>
            <div className="text-sm text-emerald-50">
              {t("terminal.recent.via", { rail: toast.rail })}
              {toast.source === "STATIC_QR" ? ` · ${t("terminal.recent.qr")}` : ""}
            </div>
          </div>
        </div>
      )}

      {error && <div className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</div>}

      {!tx ? (
        <>
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-right">
            <div className="text-sm text-slate-400">{t("terminal.sale", { category: category ? t(`terminal.category.${category}` as Key) : "—" })}</div>
            <div className="mt-1 text-5xl font-bold tabular-nums">
              {amount || "0"} <span className="text-xl text-slate-400">{etb}</span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {PRESETS.map((p) => (
              <button key={p} onClick={() => setAmount(String(p))} className="rounded-xl border border-brand/40 bg-brand/10 py-3 font-semibold text-brand active:scale-95">
                {p} {etb}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-2">
            {KEYS.map((k) => (
              <button
                key={k}
                onClick={() => press(k)}
                aria-label={k === "⌫" ? t("terminal.backspace") : k}
                className="flex h-16 items-center justify-center rounded-xl bg-slate-800 text-2xl font-semibold active:scale-95 active:bg-slate-700"
              >
                {k === "⌫" ? <Delete className="h-6 w-6" /> : k}
              </button>
            ))}
          </div>

          {noRouting ? (
            onNeedSetup ? (
              <button onClick={onNeedSetup} className="flex items-center justify-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-sm text-amber-200">
                <TriangleAlert className="h-4 w-4 shrink-0" /> {t("terminal.noRouting")}
              </button>
            ) : (
              <Link href="/dashboard/merchant?tab=accounts" className="flex items-center justify-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-sm text-amber-200">
                <TriangleAlert className="h-4 w-4 shrink-0" /> {t("terminal.noRouting")}
              </Link>
            )
          ) : (
            routing && (
              <div className="flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-3 py-2 text-sm text-slate-300">
                <Route className="h-4 w-4 shrink-0 text-brand" />
                <span className="text-slate-500">{t("terminal.routingTo")}</span>
                <span className="font-medium">{routingLabel}</span>
              </div>
            )
          )}

          <button
            onClick={generate}
            disabled={busy || !(amountNum > 0) || !merchantId || noRouting}
            className="flex items-center justify-center gap-2 rounded-2xl bg-brand py-4 text-lg font-bold text-slate-950 transition disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Nfc className="h-5 w-5" />}
            {t("terminal.charge")}
          </button>
          <p className="text-center text-xs text-slate-500">{t("terminal.help")}</p>

          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-300">
              <ScanLine className="h-4 w-4 text-brand" /> {t("terminal.recent.title")}
            </h3>
            {recent.length === 0 ? (
              <p className="text-sm text-slate-500">{t("terminal.recent.empty")}</p>
            ) : (
              <ul className="divide-y divide-slate-800">
                {recent.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="font-semibold tabular-nums">
                        {fmt(Number(r.amount))} {r.currency === "ETB" ? etb : r.currency}
                      </div>
                      <div className="truncate text-xs text-slate-500">
                        {new Date(r.created_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Addis_Ababa" })} · {t("terminal.recent.via", { rail: r.rail })}
                        {r.source === "STATIC_QR" ? ` · ${t("terminal.recent.qr")}` : ""}
                      </div>
                    </div>
                    <Check className="h-4 w-4 shrink-0 text-emerald-400" />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <div className="text-center">
            <div className="text-sm text-slate-400">{t("terminal.waiting")}</div>
            <div className="text-4xl font-bold tabular-nums">
              {fmt(Number(tx.amount))} {etb}
            </div>
          </div>

          {txRoutingLabel && (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Route className="h-3.5 w-3.5 text-brand" /> {t("terminal.routingTo")} <span className="font-medium text-slate-200">{txRoutingLabel}</span>
            </div>
          )}

          {native ? (
            <TapStatus nfc={native.nfc} tapped={tapped} processing={processing} onSettings={() => window.TwoPayNative?.openNfcSettings()} />
          ) : (
            <NfcStatus state={nfc} onRetry={() => writeNfc(payUrl)} />
          )}

          <div className="relative">
            <div className={`rounded-2xl bg-white p-4 transition-opacity ${expired ? "opacity-20" : ""}`}>
              <QRCodeSVG key={tx.token} value={payUrl} size={240} level="M" marginSize={0} />
            </div>
            {expired && (
              <button
                onClick={() => rotate(tx, true)}
                disabled={refreshing}
                className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-2xl text-lg font-bold text-white"
              >
                {refreshing ? <Loader2 className="h-8 w-8 animate-spin" /> : <RefreshCw className="h-8 w-8" />}
                {paused ? t("terminal.qr.tapKeep") : t("terminal.qr.tapRefresh")}
              </button>
            )}
          </div>

          {processing && (
            <div className="flex w-full items-center justify-center gap-2 rounded-xl bg-sky-500/10 px-3 py-2 text-sm font-medium text-sky-300">
              <Loader2 className="h-4 w-4 animate-spin" /> {t("terminal.processing")}
            </div>
          )}

          {!expired && !processing && (
            <div className="w-full space-y-1.5">
              <div className="h-1.5 w-full overflow-hidden rounded bg-slate-800">
                <div className="h-full bg-brand transition-[width] duration-500" style={{ width: `${Math.min(100, (secondsLeft / NODE_TTL_S) * 100)}%` }} />
              </div>
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span className="flex items-center gap-1.5">
                  <QrCode className="h-3.5 w-3.5 text-brand" /> {t("terminal.qr.auto", { n: rotations + 1 })}
                </span>
                <span className="flex items-center gap-1.5">
                  {paused ? (
                    <span className="text-amber-400">{t("terminal.qr.lastCode", { s: secondsLeft })}</span>
                  ) : refreshing ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("terminal.qr.refreshing")}
                    </>
                  ) : refreshFailed ? (
                    <span className="text-amber-400">{t("terminal.qr.retrying")}</span>
                  ) : (
                    t("terminal.qr.newIn", { s: refreshIn })
                  )}
                </span>
              </div>
            </div>
          )}

          {paused && (
            <div className="flex w-full flex-col items-center gap-2 rounded-xl bg-amber-500/10 p-3 text-center text-xs text-amber-300">
              {t("terminal.qr.paused")}
              <button onClick={() => rotate(tx, true)} disabled={refreshing} className="inline-flex items-center gap-1.5 rounded-lg bg-amber-400 px-3 py-1.5 font-semibold text-slate-950">
                {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} {t("terminal.qr.keepActive")}
              </button>
            </div>
          )}
          {expired && refreshFailed && <p className="text-center text-xs text-amber-300">{t("terminal.qr.offline")}</p>}

          <button onClick={copy} className="flex w-full items-center justify-center gap-2 rounded-xl bg-slate-800 py-3 text-sm font-medium">
            {copied ? <Check className="h-4 w-4 text-brand" /> : <Copy className="h-4 w-4" />}
            {copied ? t("terminal.copiedLink") : t("terminal.copyLink")}
          </button>
          <a href={payUrl} target="_blank" rel="noreferrer" className="break-all text-center text-xs text-slate-500 underline">
            {payUrl}
          </a>

          <button onClick={() => reset(true)} className="text-sm text-slate-400 underline">
            {t("terminal.cancelSale")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Tap-to-pay status inside the Android app, where this phone itself is the "tag" the customer taps. */
function TapStatus({ nfc, tapped, processing, onSettings }: { nfc: NativeInfo["nfc"]; tapped: boolean; processing: boolean; onSettings: () => void }) {
  const t = useT();
  const base = "flex w-full items-center justify-center gap-2 rounded-xl px-3 py-3 text-center text-sm font-medium";
  if (nfc === "UNSUPPORTED") return <div className={`${base} bg-slate-800 text-slate-400`}>{t("terminal.tap.unsupported")}</div>;
  if (nfc === "DISABLED") {
    return (
      <button onClick={onSettings} className={`${base} bg-amber-500/10 text-amber-300`}>
        <Nfc className="h-4 w-4 shrink-0" /> {t("terminal.tap.off")}
      </button>
    );
  }
  if (processing) return <div className={`${base} bg-sky-500/10 text-sky-300`}>{t("terminal.tap.approving")}</div>;
  if (tapped) {
    return (
      <div className={`${base} bg-emerald-500/10 text-emerald-300`}>
        <Check className="h-4 w-4 shrink-0" /> {t("terminal.tap.tapped")}
      </div>
    );
  }
  return (
    <div className={`${base} bg-brand/10 text-emerald-200`}>
      <span className="relative flex h-3 w-3 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-70" />
        <span className="relative inline-flex h-3 w-3 rounded-full bg-brand" />
      </span>
      {t("terminal.tap.ready")}
    </div>
  );
}

function NfcStatus({ state, onRetry }: { state: NfcState; onRetry: () => void }) {
  const t = useT();
  const base = "flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2 text-center text-sm";
  switch (state.kind) {
    case "waiting":
      return (
        <div className={`${base} bg-sky-500/10 text-sky-300`}>
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> {t("terminal.nfc.waiting")}
        </div>
      );
    case "written":
      return (
        <div className={`${base} bg-emerald-500/10 text-emerald-300`}>
          <Check className="h-4 w-4 shrink-0" /> {t("terminal.nfc.written")}
        </div>
      );
    case "blocked":
      return (
        <button onClick={onRetry} className={`${base} bg-amber-500/10 text-amber-300`}>
          <Nfc className="h-4 w-4 shrink-0" /> {t("terminal.nfc.blocked")}
        </button>
      );
    case "failed":
      return <div className={`${base} bg-rose-500/10 text-rose-300`}>{t("terminal.nfc.failed", { message: state.message })}</div>;
    case "unsupported":
      return <div className={`${base} bg-slate-800 text-slate-400`}>{t("terminal.nfc.unsupported")}</div>;
    default:
      return null;
  }
}
