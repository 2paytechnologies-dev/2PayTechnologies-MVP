"use client";

import { use, useEffect, useRef, useState } from "react";
import { Download, Loader2, XCircle, Zap } from "lucide-react";
import { fmt, formatEAT } from "@/lib/format";
import type { ReceiptView, ServedAd } from "@/lib/types";

type State = { kind: "loading" } | { kind: "ready"; receipt: ReceiptView } | { kind: "error"; message: string };

function mapsHref(loc: string): string {
  return /^https?:\/\//i.test(loc) ? loc : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc)}`;
}

/** Renders the receipt to a PNG on a canvas and downloads it. No server round trip, works offline. */
function saveReceiptImage(r: ReceiptView) {
  const W = 720;
  const H = 880;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d");
  if (!g) return;
  const font = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, W, H);
  g.textAlign = "center";

  g.fillStyle = "#059669";
  g.font = `700 40px ${font}`;
  g.fillText("2Pay", W / 2, 90);
  g.fillStyle = "#0f172a";
  g.font = `600 30px ${font}`;
  g.fillText("Payment Receipt", W / 2, 140);

  g.fillStyle = "#d1fae5";
  g.beginPath();
  g.roundRect(W / 2 - 170, 175, 340, 56, 28);
  g.fill();
  g.fillStyle = "#047857";
  g.font = `600 26px ${font}`;
  g.fillText("✓ Payment Successful", W / 2, 212);

  g.fillStyle = "#0f172a";
  g.font = `800 68px ${font}`;
  g.fillText(`${fmt(r.amount)} ${r.currency}`, W / 2, 330);

  g.fillStyle = "#475569";
  g.font = `400 26px ${font}`;
  g.fillText(`Paid to: ${r.merchant_name}`, W / 2, 410);
  g.fillText(`${r.terminal_id}${r.location ? ` • ${r.location}` : ""}`, W / 2, 450);
  g.fillText(`Ref: ${r.reference}`, W / 2, 510);
  g.fillText(formatEAT(r.paid_at), W / 2, 550);
  g.fillText(`Rail: ${r.rail}`, W / 2, 590);

  g.strokeStyle = "#cbd5e1";
  g.setLineDash([10, 8]);
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(60, 650);
  g.lineTo(W - 60, 650);
  g.stroke();

  g.fillStyle = "#94a3b8";
  g.font = `400 22px ${font}`;
  g.fillText("2Pay never holds your funds. Settled on licensed rails.", W / 2, 710);

  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `2pay-receipt-${r.reference}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, "image/png");
}

export default function ReceiptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [closed, setClosed] = useState(false);
  const billed = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/pay/${token}/receipt`)
      .then(async (r) => {
        const d = await r.json();
        if (cancelled) return;
        if (!r.ok) {
          setState({
            kind: "error",
            message: r.status === 409 ? "This payment has not been completed yet." : r.status === 404 ? "Receipt not found." : "Could not load your receipt.",
          });
          return;
        }
        setState({ kind: "ready", receipt: d as ReceiptView });
      })
      .catch(() => !cancelled && setState({ kind: "error", message: "Cannot reach 2Pay." }));
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Micro-billing hook: log the impression and bill the campaign once the receipt (and its ad) is on screen.
  const receipt = state.kind === "ready" ? state.receipt : null;
  useEffect(() => {
    if (!receipt?.ad || billed.current) return;
    billed.current = true;
    fetch("/api/ads/impression", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ campaign_id: receipt.ad.id, transaction_id: receipt.transaction_id }),
    }).catch(() => {
      /* billing is best-effort and idempotent server-side; never disturb the receipt */
    });
  }, [receipt]);

  const trackClick = (ad: ServedAd, transactionId: string) => {
    fetch("/api/ads/click", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ campaign_id: ad.id, transaction_id: transactionId }),
      keepalive: true,
    }).catch(() => {});
  };

  const close = () => {
    window.close(); // only works for script-opened tabs; otherwise show the closing screen
    setClosed(true);
  };

  return (
    <div className="fixed inset-0 overflow-y-auto bg-white text-slate-900">
      <main className="mx-auto flex min-h-full max-w-md flex-col px-5 pb-8 pt-6">
        {state.kind === "loading" && (
          <div className="flex flex-1 items-center justify-center gap-2 text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading receipt…
          </div>
        )}

        {state.kind === "error" && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <XCircle className="h-14 w-14 text-rose-500" />
            <p className="text-slate-600">{state.message}</p>
          </div>
        )}

        {receipt && closed && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <div className="text-5xl">✓</div>
            <h1 className="text-xl font-bold">Thank you</h1>
            <p className="text-slate-500">Your receipt is saved with 2Pay. You can close this page.</p>
          </div>
        )}

        {receipt && !closed && (
          <>
            <header className="flex flex-col items-center gap-1 pt-2 text-center">
              <div className="flex items-center gap-1.5 text-emerald-600">
                <Zap className="h-6 w-6" fill="currentColor" />
                <span className="text-2xl font-extrabold tracking-tight">2Pay</span>
              </div>
              <h1 className="text-lg font-semibold text-slate-700">Payment Receipt</h1>
            </header>

            <div className="mt-5 flex justify-center">
              <span className="rounded-full bg-emerald-100 px-4 py-1.5 text-sm font-semibold text-emerald-700">✓ Payment Successful</span>
            </div>

            <p className="mt-5 text-center text-5xl font-extrabold tabular-nums tracking-tight">
              {fmt(receipt.amount)} <span className="text-3xl font-bold text-slate-500">{receipt.currency}</span>
            </p>

            <div className="mt-5 space-y-1 text-center text-sm text-slate-600">
              <p>
                Paid to: <span className="font-semibold text-slate-800">{receipt.merchant_name}</span> • {receipt.terminal_id}
                {receipt.location ? ` • ${receipt.location}` : ""}
              </p>
              <p>
                Ref: <span className="font-mono font-semibold text-slate-800">{receipt.reference}</span> • {formatEAT(receipt.paid_at)}
              </p>
            </div>

            <hr className="my-6 border-t-2 border-dashed border-slate-200" />

            {/* Bottom-anchored sponsored slot */}
            <div className="mt-auto flex flex-col gap-5">
              {receipt.ad && (
                <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                  <span className="inline-block rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700">📢 Sponsored Nearby Offer</span>
                  <div className="mt-3 flex items-start gap-3">
                    {receipt.ad.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={receipt.ad.image_url}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="h-16 w-16 shrink-0 rounded-xl border border-amber-200 bg-white object-cover"
                      />
                    ) : (
                      <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border border-amber-200 bg-white text-2xl">🏪</div>
                    )}
                    <div className="min-w-0">
                      <h2 className="font-bold leading-snug text-slate-900">{receipt.ad.title}</h2>
                      <p className="mt-0.5 text-sm text-slate-600">{receipt.ad.description}</p>
                    </div>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <CtaButton
                      href={receipt.ad.phone_cta ? `tel:${receipt.ad.phone_cta}` : null}
                      onClick={() => trackClick(receipt.ad!, receipt.transaction_id)}
                      label="📞 Call"
                    />
                    <CtaButton
                      href={receipt.ad.location_cta ? mapsHref(receipt.ad.location_cta) : null}
                      external
                      onClick={() => trackClick(receipt.ad!, receipt.transaction_id)}
                      label="📍 View Location"
                    />
                  </div>
                </section>
              )}

              <div className="flex flex-col gap-2">
                <button
                  onClick={() => saveReceiptImage(receipt)}
                  className="flex items-center justify-center gap-2 rounded-2xl border-2 border-slate-300 bg-white py-3.5 font-semibold text-slate-700 active:bg-slate-50"
                >
                  <Download className="h-5 w-5" /> Save Digital Receipt
                </button>
                <button onClick={close} className="rounded-2xl bg-emerald-600 py-3.5 font-bold text-white active:bg-emerald-700">
                  Done / Close
                </button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function CtaButton({
  href,
  label,
  external,
  onClick,
}: {
  href: string | null;
  label: string;
  external?: boolean;
  onClick: () => void;
}) {
  const cls = "flex items-center justify-center rounded-xl border border-amber-300 bg-white py-2.5 text-sm font-semibold text-amber-800";
  if (!href) return <span className={`${cls} opacity-40`}>{label}</span>;
  return (
    <a
      href={href}
      onClick={onClick}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={`${cls} active:bg-amber-100`}
    >
      {label}
    </a>
  );
}
