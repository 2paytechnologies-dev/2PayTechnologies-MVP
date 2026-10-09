"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Check, CheckCircle2, Copy, Delete, Loader2, Nfc, RotateCcw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { isPaid, type Transaction } from "@/lib/types";
import { primeAudio, playSettlementChime } from "@/lib/chime";

const PRESETS = [100, 500, 1000];
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"];

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
  /** Fires true while a pay node is live, so the host can lock its merchant picker. */
  onActiveChange?: (active: boolean) => void;
}

/**
 * Cashier keypad -> single-use pay node. Delivery is tap-first: the pay URL is written to an NFC tag
 * with Web NFC where available, and the dynamic QR is always shown as the fallback.
 */
export function TerminalPanel({ merchantId, merchantName, category, onActiveChange }: Props) {
  const [amount, setAmount] = useState("");
  const [tx, setTx] = useState<Transaction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [done, setDone] = useState<Transaction | null>(null);
  const [nfc, setNfc] = useState<NfcState>({ kind: "idle" });
  const toneFired = useRef(false);
  const nfcAbort = useRef<AbortController | null>(null);

  const finish = useCallback((t: Transaction) => {
    setDone((prev) => {
      if (prev) return prev;
      if (!toneFired.current) {
        toneFired.current = true;
        playSettlementChime();
      }
      return t;
    });
  }, []);

  // Realtime listener (+ 2s polling fallback in case Realtime is not enabled).
  useEffect(() => {
    if (!tx || done) return;
    const channel = supabase
      .channel(`tx-${tx.token}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "transactions", filter: `token=eq.${tx.token}` },
        (payload) => {
          const row = payload.new as Transaction;
          if (isPaid(row.status)) finish(row);
        },
      )
      .subscribe();

    const poll = setInterval(async () => {
      const { data } = await supabase.from("transactions").select("*").eq("token", tx.token).single();
      if (data && isPaid(data.status)) finish(data as Transaction);
    }, 2000);

    return () => {
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [tx, done, finish]);

  // TTL countdown
  useEffect(() => {
    if (!tx || done) return;
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((new Date(tx.expires_at).getTime() - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [tx, done]);

  useEffect(() => () => nfcAbort.current?.abort(), []);

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

  const reset = () => {
    stopNfc();
    setTx(null);
    setDone(null);
    setAmount("");
    setCopied(false);
    setNfc({ kind: "idle" });
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
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchant_id: merchantId, amount: Number(amount) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create pay node");
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

  const expired = !!tx && !done && secondsLeft === 0;
  const amountNum = Number(amount);

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
        <button onClick={reset} className="mt-10 inline-flex items-center gap-2 rounded-2xl bg-white px-8 py-4 text-lg font-bold text-emerald-700">
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

          <button
            onClick={generate}
            disabled={busy || !(amountNum > 0) || !merchantId}
            className="flex items-center justify-center gap-2 rounded-2xl bg-brand py-4 text-lg font-bold text-slate-950 transition disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Nfc className="h-5 w-5" />}
            Tap to Charge
          </button>
          <p className="text-center text-xs text-slate-500">Writes the pay link to an NFC tag when supported; otherwise shows a QR code.</p>
        </>
      ) : (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <div className="text-center">
            <div className="text-sm text-slate-400">Awaiting customer authorization</div>
            <div className="text-4xl font-bold tabular-nums">
              {Number(tx.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })} ETB
            </div>
          </div>

          <NfcStatus state={nfc} onRetry={() => writeNfc(payUrl)} />

          <div className={`rounded-2xl bg-white p-4 ${expired ? "opacity-20" : ""}`}>
            <QRCodeSVG value={payUrl} size={224} />
          </div>

          {expired ? (
            <div className="font-semibold text-rose-400">Pay node expired</div>
          ) : (
            <div className="flex items-center gap-2 text-slate-300">
              <Loader2 className="h-4 w-4 animate-spin text-brand" />
              Expires in <span className="font-mono font-bold text-white">{secondsLeft}s</span>
            </div>
          )}

          <button onClick={copy} className="flex w-full items-center justify-center gap-2 rounded-xl bg-slate-800 py-3 text-sm font-medium">
            {copied ? <Check className="h-4 w-4 text-brand" /> : <Copy className="h-4 w-4" />}
            {copied ? "NFC payload URL copied" : "Copy NFC payload URL"}
          </button>
          <a href={payUrl} target="_blank" rel="noreferrer" className="break-all text-center text-xs text-slate-500 underline">
            {payUrl}
          </a>

          <button onClick={reset} className="text-sm text-slate-400 underline">
            {expired ? "Start over" : "Cancel"}
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
      return <div className={`${base} bg-slate-800 text-slate-400`}>NFC not available on this device — scan the QR code.</div>;
    default:
      return null;
  }
}
