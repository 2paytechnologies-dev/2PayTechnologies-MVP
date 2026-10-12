"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, Store, XCircle } from "lucide-react";
import { LanguageMenu } from "@/components/LanguageMenu";
import { Logo } from "@/components/Logo";
import { useT } from "@/lib/i18n";
import { localizeError } from "@/lib/i18n/errors";

interface Shop {
  business_name: string;
  category: string;
  location: string | null;
  accepting: boolean;
}

const PRESETS = [50, 100, 200, 500];
const MAX = 20_000; // must match STATIC_QR_MAX_ETB on the server (default)

/**
 * A customer scanned the shop's printed QR (or tapped its NFC sticker): they type the amount and continue into the
 * normal checkout. The shop's cashier sees the payment arrive on their terminal.
 */
export default function ShopPayPage({ params }: { params: Promise<{ terminal: string }> }) {
  const { terminal } = use(params);
  const t = useT();
  const router = useRouter();
  const [shop, setShop] = useState<Shop | null | "missing">(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/public/terminal/${terminal}`)
      .then(async (r) => (r.ok ? setShop(await r.json()) : setShop("missing")))
      .catch(() => setShop("missing"));
  }, [terminal]);

  const value = Number(amount);
  const valid = Number.isFinite(value) && value >= 1 && value <= MAX;

  const go = async () => {
    if (!valid) return setError(t("shop.range", { max: MAX.toLocaleString("en-US") }));
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/public/terminal/${terminal}/pay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount: value }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? t("common.errorGeneric"));
      router.push(`/pay/${d.token}`);
    } catch (e) {
      setError(localizeError((e as Error).message, t));
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-brand">
          <Logo /> <span className="font-bold text-white">2Pay</span>
        </div>
        <LanguageMenu />
      </div>

      {shop === null && (
        <div className="flex items-center justify-center gap-2 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" /> {t("common.loading")}
        </div>
      )}

      {shop === "missing" && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 p-8 text-center">
          <XCircle className="h-12 w-12 text-rose-400" />
          <p className="text-slate-200">{t("shop.unknown")}</p>
        </div>
      )}

      {shop && shop !== "missing" && (
        <>
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 text-center">
            <Store className="mx-auto mb-2 h-8 w-8 text-brand" />
            <h1 className="text-xl font-bold">{t("shop.pay", { name: shop.business_name })}</h1>
            {shop.location && <p className="text-sm text-slate-500">{shop.location}</p>}
          </div>

          {shop.accepting ? (
            <>
              <label className="block space-y-2">
                <span className="text-sm font-medium text-slate-300">{t("shop.enter")}</span>
                <div className="flex items-center rounded-2xl border border-slate-700 bg-slate-950 px-4 focus-within:border-brand">
                  <input
                    value={amount}
                    onChange={(e) => {
                      setAmount(e.target.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1"));
                      setError(null);
                    }}
                    inputMode="decimal"
                    autoFocus
                    placeholder="0"
                    maxLength={9}
                    onKeyDown={(e) => e.key === "Enter" && void go()}
                    className="h-16 w-full bg-transparent text-4xl font-bold tabular-nums placeholder:text-slate-700 focus:outline-none"
                  />
                  <span className="text-xl text-slate-400">{t("common.etb")}</span>
                </div>
              </label>
              <div className="grid grid-cols-4 gap-2">
                {PRESETS.map((p) => (
                  <button key={p} onClick={() => setAmount(String(p))} className="rounded-xl border border-brand/40 bg-brand/10 py-2.5 font-semibold text-brand active:scale-95">
                    {p}
                  </button>
                ))}
              </div>
              {error && <div className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</div>}
              <button onClick={go} disabled={busy || !valid} className="flex h-14 items-center justify-center gap-2 rounded-2xl bg-brand text-lg font-bold text-slate-950 disabled:opacity-40">
                {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <ArrowRight className="h-5 w-5" />} {t("shop.continue")}
              </button>
            </>
          ) : (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-center text-sm text-amber-200">{t("shop.unavailable")}</div>
          )}
          <p className="text-center text-xs text-slate-600">{t("shop.powered")}</p>
        </>
      )}
    </main>
  );
}
