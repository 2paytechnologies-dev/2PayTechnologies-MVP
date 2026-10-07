"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Check, CheckCircle2, Copy, Delete, Loader2, Nfc, RotateCcw, Zap } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { Merchant, Transaction } from "@/lib/types";

const PRESETS = [100, 500, 1000];
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"];

/** Two-note confirmation chime via WebAudio (no asset needed). */
function playSuccessTone() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    [880, 1318.5].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = ctx.currentTime + i * 0.14;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  } catch {
    /* audio blocked — ignore */
  }
}

export default function TerminalPage() {
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [merchantId, setMerchantId] = useState("");
  const [amount, setAmount] = useState("");
  const [tx, setTx] = useState<Transaction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [done, setDone] = useState<Transaction | null>(null);
  const toneFired = useRef(false);

  useEffect(() => {
    fetch("/api/merchants")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d) && d.length) {
          setMerchants(d);
          setMerchantId(d[0].id);
        } else setError(d?.error ?? "No merchants found — run supabase/schema.sql");
      })
      .catch(() => setError("Cannot reach API"));
  }, []);

  const finish = useCallback((t: Transaction) => {
    setDone((prev) => {
      if (prev) return prev;
      if (!toneFired.current) {
        toneFired.current = true;
        playSuccessTone();
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
          if (row.status === "SUCCESS") finish(row);
        },
      )
      .subscribe();

    const poll = setInterval(async () => {
      const { data } = await supabase.from("transactions").select("*").eq("token", tx.token).single();
      if (data?.status === "SUCCESS") finish(data as Transaction);
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

  const press = (k: string) => {
    setAmount((a) => {
      if (k === "⌫") return a.slice(0, -1);
      if (k === ".") return a.includes(".") || a === "" ? (a === "" ? "0." : a) : a + ".";
      if (a.includes(".") && a.split(".")[1].length >= 2) return a;
      if (a.length >= 8) return a;
      return a === "0" ? k : a + k;
    });
  };

  const reset = () => {
    setTx(null);
    setDone(null);
    setAmount("");
    setCopied(false);
    toneFired.current = false;
  };

  const generate = async () => {
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

  const merchant = merchants.find((m) => m.id === merchantId);
  const expired = !!tx && !done && secondsLeft === 0;
  const amountNum = Number(amount);

  // Full-screen success
  if (done) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-emerald-500 p-6 text-center text-white">
        <CheckCircle2 className="mb-6 h-32 w-32" strokeWidth={1.5} />
        <h1 className="text-5xl font-extrabold">Payment Received</h1>
        <p className="mt-4 text-6xl font-black">
          {done.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })} {done.currency}
        </p>
        <p className="mt-6 text-2xl font-semibold">
          Settled in {((done.latency_ms ?? 0) / 1000).toFixed(1)}s via {done.rail}
        </p>
        <p className="mt-1 text-emerald-100">{merchant?.business_name}</p>
        <button
          onClick={reset}
          className="mt-10 inline-flex items-center gap-2 rounded-2xl bg-white px-8 py-4 text-lg font-bold text-emerald-700"
        >
          <RotateCcw className="h-5 w-5" /> New sale
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-4">
      <header className="flex items-center justify-between pt-2">
        <div className="flex items-center gap-2 text-brand">
          <Zap className="h-5 w-5" /> <span className="font-semibold">2Pay Terminal</span>
        </div>
        <select
          value={merchantId}
          onChange={(e) => setMerchantId(e.target.value)}
          disabled={!!tx}
          className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
        >
          {merchants.map((m) => (
            <option key={m.id} value={m.id}>
              {m.business_name} · {m.terminal_id}
            </option>
          ))}
        </select>
      </header>

      {error && <div className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</div>}

      {!tx ? (
        <>
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-right">
            <div className="text-sm text-slate-400">{merchant?.category ?? "—"} sale</div>
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
            Generate Dynamic Pay Node
          </button>
        </>
      ) : (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <div className="text-center">
            <div className="text-sm text-slate-400">Awaiting customer authorization</div>
            <div className="text-4xl font-bold tabular-nums">
              {tx.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })} ETB
            </div>
          </div>

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

          <button
            onClick={copy}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-slate-800 py-3 text-sm font-medium"
          >
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
    </main>
  );
}
