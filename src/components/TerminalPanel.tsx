"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import Link from "next/link";
import { Check, CheckCircle2, Copy, Delete, Loader2, Nfc, QrCode, RefreshCw, RotateCcw, Route, TriangleAlert } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { isPaid, type Transaction } from "@/lib/types";
import { primeAudio, playSettlementChime } from "@/lib/chime";

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
}

const msLeft = (iso: string) => new Date(iso).getTime() - Date.now();

/**
 * Cashier keypad -> single-use pay node. Two ways to reach the payer:
 *  - NFC: the pay URL is written to a tag with Web NFC where the device supports it (optional extra).
 *  - Dynamic QR (always shown, works on any camera or QR-capable app): it refreshes itself, so the cashier never
 *    has to touch the screen while waiting. Each QR is a fresh single-use node; the previous one stays valid for
 *    its last seconds so a customer who is mid-scan is not cut off, and any of them being paid completes the sale.
 */
export function TerminalPanel({ merchantId, merchantName, category, routing, onActiveChange }: Props) {
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
  const toneFired = useRef(false);
  const nfcAbort = useRef<AbortController | null>(null);
  const tokens = useRef<Set<string>>(new Set());
  const rotationsRef = useRef(0);

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
    (t: Transaction) => {
      setDone((prev) => {
        if (prev) return prev;
        if (!toneFired.current) {
          toneFired.current = true;
          playSettlementChime();
        }
        tokens.current.forEach((tok) => tok !== t.token && cancelNode(tok)); // the sale is settled; retire the other QRs
        return t;
      });
    },
    [cancelNode],
  );

  // Payment listener over ALL live nodes (+ 2s polling fallback in case Realtime is not enabled).
  const listening = !!tx && !done;
  useEffect(() => {
    if (!listening) return;
    const channel = supabase
      .channel(`terminal-${merchantId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "transactions", filter: `merchant_id=eq.${merchantId}` }, (payload) => {
        const row = payload.new as Transaction;
        if (tokens.current.has(row.token) && isPaid(row.status)) finish(row);
      })
      .subscribe();

    const poll = setInterval(async () => {
      const list = [...tokens.current];
      if (!list.length) return;
      const { data } = await supabase.from("transactions").select("*").in("token", list).in("status", ["SUCCESS", "SETTLED"]).limit(1);
      if (data?.[0]) finish(data[0] as Transaction);
    }, 2000);

    return () => {
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [listening, merchantId, finish]);

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
    if (!tx || done || paused) return;
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
  }, [tx, done, paused, rotate]);

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
      void writeNfc(`${window.location.origin}/pay/${data.token}`);
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

  if (done) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-emerald-500 p-6 text-center text-white">
        <CheckCircle2 className="mb-6 h-32 w-32" strokeWidth={1.5} />
        <h1 className="text-5xl font-extrabold">Payment Received</h1>
        <p className="mt-2 text-3xl font-bold">ተከፍሏል</p>
        <p className="mt-4 text-6xl font-black">
          {Number(done.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })} {done.currency}
        </p>
        <p className="mt-6 text-2xl font-semibold">
          Authorized in {((done.latency_ms ?? 0) / 1000).toFixed(1)}s via {done.rail}
        </p>
        <p className="mt-1 text-emerald-100">{merchantName}</p>
        <button onClick={() => reset()} className="mt-10 inline-flex items-center gap-2 rounded-2xl bg-white px-8 py-4 text-lg font-bold text-emerald-700">
          <RotateCcw className="h-5 w-5" /> New sale
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4" onPointerDownCapture={primeAudio}>
      {error && <div className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</div>}

      {!tx ? (
        <>
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-right">
            <div className="text-sm text-slate-400">{category ?? "—"} sale</div>
            <div className="mt-1 text-5xl font-bold tabular-nums">
              {amount || "0"} <span className="text-xl text-slate-400">ETB</span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => setAmount(String(p))}
                className="rounded-xl border border-brand/40 bg-brand/10 py-3 font-semibold text-brand active:scale-95"
              >
                {p} ETB
              </button>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-2">
            {KEYS.map((k) => (
              <button
                key={k}
                onClick={() => press(k)}
                aria-label={k === "⌫" ? "Backspace" : k}
                className="flex h-16 items-center justify-center rounded-xl bg-slate-800 text-2xl font-semibold active:scale-95 active:bg-slate-700"
              >
                {k === "⌫" ? <Delete className="h-6 w-6" /> : k}
              </button>
            ))}
          </div>

          {noRouting ? (
            <Link
              href="/dashboard/settings"
              className="flex items-center justify-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200"
            >
              <TriangleAlert className="h-4 w-4 shrink-0" /> No settlement account set — configure bank &amp; wallet routing
            </Link>
          ) : (
            routing && (
              <div className="flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-3 py-2 text-sm text-slate-300" aria-label="Settlement routing">
                <Route className="h-4 w-4 shrink-0 text-brand" />
                <span className="text-slate-500">Routing to:</span>
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
            Tap to Charge
          </button>
          <p className="text-center text-xs text-slate-500">Shows a self-refreshing QR code for any phone, and writes an NFC tag too where supported.</p>
        </>
      ) : (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <div className="text-center">
            <div className="text-sm text-slate-400">Awaiting customer — scan to pay</div>
            <div className="text-4xl font-bold tabular-nums">
              {Number(tx.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })} ETB
            </div>
          </div>

          {txRoutingLabel && (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Route className="h-3.5 w-3.5 text-brand" /> Routing to: <span className="font-medium text-slate-200">{txRoutingLabel}</span>
            </div>
          )}

          <NfcStatus state={nfc} onRetry={() => writeNfc(payUrl)} />

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
                {paused ? "Tap to keep QR active" : "Tap to refresh QR"}
              </button>
            )}
          </div>

          {!expired && (
            <div className="w-full space-y-1.5">
              <div className="h-1.5 w-full overflow-hidden rounded bg-slate-800">
                <div className="h-full bg-brand transition-[width] duration-500" style={{ width: `${Math.min(100, (secondsLeft / NODE_TTL_S) * 100)}%` }} />
              </div>
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span className="flex items-center gap-1.5">
                  <QrCode className="h-3.5 w-3.5 text-brand" /> Auto-refreshing QR · code #{rotations + 1}
                </span>
                <span className="flex items-center gap-1.5">
                  {paused ? (
                    <span className="text-amber-400">last code — expires in {secondsLeft}s</span>
                  ) : refreshing ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> refreshing…
                    </>
                  ) : refreshFailed ? (
                    <span className="text-amber-400">retrying…</span>
                  ) : (
                    <>
                      new code in <span className="font-mono font-bold text-slate-200">{refreshIn}s</span>
                    </>
                  )}
                </span>
              </div>
            </div>
          )}

          {paused && (
            <div className="flex w-full flex-col items-center gap-2 rounded-xl bg-amber-500/10 p-3 text-center text-xs text-amber-300">
              QR refresh paused after several minutes without a payment.
              <button onClick={() => rotate(tx, true)} disabled={refreshing} className="inline-flex items-center gap-1.5 rounded-lg bg-amber-400 px-3 py-1.5 font-semibold text-slate-950">
                {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Keep QR active
              </button>
            </div>
          )}
          {expired && refreshFailed && <p className="text-center text-xs text-amber-300">Could not reach 2Pay to refresh the code. Check the connection and tap the QR.</p>}

          <button onClick={copy} className="flex w-full items-center justify-center gap-2 rounded-xl bg-slate-800 py-3 text-sm font-medium">
            {copied ? <Check className="h-4 w-4 text-brand" /> : <Copy className="h-4 w-4" />}
            {copied ? "Pay link copied" : "Copy pay link"}
          </button>
          <a href={payUrl} target="_blank" rel="noreferrer" className="break-all text-center text-xs text-slate-500 underline">
            {payUrl}
          </a>

          <button onClick={() => reset(true)} className="text-sm text-slate-400 underline">
            Cancel sale
          </button>
        </div>
      )}
    </div>
  );
}

function NfcStatus({ state, onRetry }: { state: NfcState; onRetry: () => void }) {
  const base = "flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm";
  switch (state.kind) {
    case "waiting":
      return (
        <div className={`${base} bg-sky-500/10 text-sky-300`}>
          <Loader2 className="h-4 w-4 animate-spin" /> Hold an NFC tag to the back of this device…
        </div>
      );
    case "written":
      return (
        <div className={`${base} bg-emerald-500/10 text-emerald-300`}>
          <Check className="h-4 w-4" /> Tag written — customer can tap it
        </div>
      );
    case "blocked":
      return (
        <button onClick={onRetry} className={`${base} bg-amber-500/10 text-amber-300`}>
          <Nfc className="h-4 w-4" /> NFC needs a tap to start — press to retry (QR below works now)
        </button>
      );
    case "failed":
      return <div className={`${base} bg-rose-500/10 text-rose-300`}>NFC write failed: {state.message}. Use the QR code.</div>;
    case "unsupported":
      return <div className={`${base} bg-slate-800 text-slate-400`}>No NFC on this device — customers scan the QR code below.</div>;
    default:
      return null;
  }
}
