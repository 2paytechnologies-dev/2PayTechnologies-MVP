"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { CheckCircle2, Loader2, Nfc, TriangleAlert } from "lucide-react";
import { Logo } from "@/components/Logo";
import { LanguageMenu } from "@/components/LanguageMenu";
import { startLongPoll } from "@/lib/poll";
import { clearPayLink, keepScreenAwake, nativeInfo, presentPayLink, type NativeInfo } from "@/lib/native";
import { playSettlementChime, preloadAnnouncement, primeAudio } from "@/lib/chime";
import { fmt } from "@/lib/format";
import { useI18n, useT } from "@/lib/i18n";

const QRCodeSVG = dynamic(() => import("qrcode.react").then((m) => m.QRCodeSVG), { ssr: false, loading: () => <div className="h-[220px] w-[220px] animate-pulse rounded-xl bg-slate-800" /> });

const API = "/api/v1/integrations/ride-hailing/session";
/** A fresh pay node is minted this long before the current one expires (each lives 90 s), so the tap and the QR never lapse. */
const REFRESH_LEAD_MS = 20_000;
const RETRY_MS = 3_000;

interface Node {
  token: string;
  amount: number;
  currency: string;
  expires_at: string;
}
interface Paid {
  amount: number;
  tip_amount?: number | null;
  currency: string;
  rail: string;
  latency_ms?: number | null;
}

/**
 * The driver's phone after a ride-hailing app hands over a checkout link (`twopay://checkout?token=...`, or this page with
 * `?session_token=`). The fare and the driver's accounts come from the ride, so there is no keypad: it mints the pay node, offers it
 * to the passenger's phone by tap (in the 2Pay app) or QR, keeps a fresh node ready, and shows the result the moment it clears.
 */
export function RideTerminal({ sessionToken }: { sessionToken: string }) {
  const t = useT();
  const { lang } = useI18n();
  const [node, setNode] = useState<Node | null>(null);
  const [error, setError] = useState<{ code: string | null; text: string } | null>(null);
  const [paid, setPaid] = useState<Paid | null>(null);
  const [processing, setProcessing] = useState(false);
  const [native, setNative] = useState<NativeInfo | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const paidRef = useRef(false);
  const langRef = useRef(lang);
  useEffect(() => {
    langRef.current = lang;
  }, [lang]);

  const mint = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`${API}/mint`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_token: sessionToken }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        // A link that is invalid, expired, cancelled or already paid will not get better by asking again.
        if (d.code === "ALREADY_PAID") return true;
        setError({ code: d.code ?? null, text: d.error ?? t("common.errorGeneric") });
        return !!d.code?.startsWith("SESSION_");
      }
      setError(null);
      setNode({ token: d.token, amount: Number(d.amount), currency: d.currency, expires_at: d.expires_at });
      setNow(Date.now());
      return true;
    } catch {
      setError({ code: null, text: t("common.offline") });
      return false;
    }
  }, [sessionToken, t]);

  useEffect(() => {
    preloadAnnouncement();
    setNative(nativeInfo());
    void mint();
  }, [mint]);

  // Keep a fresh node ready before the current one lapses.
  const expiresAt = node?.expires_at;
  useEffect(() => {
    if (!expiresAt || paid) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const again = async () => {
      if (stop || paidRef.current) return;
      const settled = await mint();
      if (!settled && !stop) timer = setTimeout(again, RETRY_MS);
    };
    timer = setTimeout(again, Math.max(0, new Date(expiresAt).getTime() - Date.now() - REFRESH_LEAD_MS));
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [expiresAt, paid, mint]);

  // Present the CURRENT pay link to taps (the 2Pay Android app acts as an NFC tag), and keep the screen on while waiting.
  const nfcReady = native?.nfc === "READY";
  const token = node?.token;
  useEffect(() => {
    if (!native || paid) return;
    keepScreenAwake(true);
    return () => {
      keepScreenAwake(false);
      clearPayLink();
    };
  }, [native, paid]);
  useEffect(() => {
    if (nfcReady && token && !paid) presentPayLink(`${window.location.origin}/pay/${token}`);
  }, [nfcReady, token, paid]);

  // Payment detection: a request held by the server, answered when the ride's state changes (about one network hop after it clears).
  useEffect(() => {
    if (paid) return;
    return startLongPoll(async (sig, signal) => {
      const res = await fetch(`${API}/status?${new URLSearchParams({ session_token: sessionToken, wait: "7", sig })}`, { cache: "no-store", signal });
      if (!res.ok) throw new Error(String(res.status));
      const d = await res.json();
      setProcessing(!!d.processing);
      if (d.paid && !paidRef.current) {
        paidRef.current = true;
        playSettlementChime(langRef.current); // the chime sounds in the same moment the result appears
        setPaid({ amount: Number(d.paid.amount), tip_amount: d.paid.tip_amount, currency: d.paid.currency, rail: d.paid.rail, latency_ms: d.paid.latency_ms });
      } else if (d.status === "CANCELLED" || d.status === "EXPIRED") {
        setError({ code: `SESSION_${d.status}`, text: d.status === "CANCELLED" ? t("ride.cancelled") : t("ride.expired") });
      }
      return res.headers.get("x-status-sig") ?? "";
    });
  }, [sessionToken, paid, t]);

  useEffect(() => {
    if (!node || paid) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [node, paid]);

  const etb = t("common.etb");
  const header = (
    <header className="flex items-center justify-between pt-2">
      <div className="flex items-center gap-2 text-brand">
        <Logo /> <span className="font-semibold">{t("ride.title")}</span>
      </div>
      <LanguageMenu />
    </header>
  );

  if (paid) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-emerald-500 p-6 text-center text-white">
        <CheckCircle2 className="mb-6 h-32 w-32" strokeWidth={1.5} />
        <h1 className="text-5xl font-extrabold">{t("terminal.done.title")}</h1>
        <p className="mt-2 text-3xl font-bold">ተከፍሏል</p>
        <p className="mt-4 text-6xl font-black">
          {fmt(Number(paid.amount) + Number(paid.tip_amount ?? 0))} {paid.currency === "ETB" ? etb : paid.currency}
        </p>
        <p className="mt-6 text-2xl font-semibold">{t("terminal.done.paidVia", { rail: paid.rail })}</p>
        <p className="mt-8 text-emerald-100">{t("ride.close")}</p>
      </div>
    );
  }

  const secondsLeft = node ? Math.max(0, Math.ceil((new Date(node.expires_at).getTime() - now) / 1000)) : 0;
  const payUrl = node ? `${typeof window === "undefined" ? "" : window.location.origin}/pay/${node.token}` : "";
  const fatal = !!error?.code?.startsWith("SESSION_");

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-4" onPointerDownCapture={primeAudio}>
      {header}
      {error && (
        <div className="flex items-start gap-2 rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> <span>{error.text}</span>
        </div>
      )}
      {!node && !fatal && (
        <div className="flex items-center justify-center gap-2 py-16 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" /> {t("ride.preparing")}
        </div>
      )}
      {node && !fatal && (
        <>
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-center">
            <div className="text-sm text-slate-400">{t("ride.fare")}</div>
            <div className="mt-1 text-6xl font-bold tabular-nums">
              {fmt(node.amount)} <span className="text-xl text-slate-400">{node.currency === "ETB" ? etb : node.currency}</span>
            </div>
          </div>
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-brand/40 bg-brand/10 p-5 text-center">
            <Nfc className="h-10 w-10 text-brand" />
            <p className="text-lg font-bold">{t("ride.hold")}</p>
            <p className="text-sm text-slate-300">{t("ride.orScan")}</p>
            <div className="rounded-xl bg-white p-3">
              <QRCodeSVG value={payUrl} size={220} marginSize={0} />
            </div>
            <p className="flex items-center gap-2 text-sm text-slate-300">
              {processing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> {t("ride.processing")}
                </>
              ) : (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> {t("ride.waiting")} · {secondsLeft}s
                </>
              )}
            </p>
          </div>
        </>
      )}
    </main>
  );
}
