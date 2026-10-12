"use client";

import { useEffect, useState } from "react";
import { Logo } from "@/components/Logo";
import { LanguageMenu } from "@/components/LanguageMenu";
import { TerminalPanel } from "@/components/TerminalPanel";
import { defaultMerchantId } from "@/lib/client-session";
import { useT } from "@/lib/i18n";
import type { Merchant } from "@/lib/types";

export default function TerminalPage() {
  const t = useT();
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [merchantId, setMerchantId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    fetch("/api/merchants", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d) && d.length) {
          setMerchants(d);
          void defaultMerchantId(d).then(setMerchantId);
        } else setError(d?.error ?? "No merchants found");
      })
      .catch(() => setError(t("common.offline")));
  }, [t]);

  const merchant = merchants.find((m) => m.id === merchantId);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <div className="flex items-center gap-2 text-brand">
          <Logo /> <span className="font-semibold">{t("portal.tab.terminal")}</span>
        </div>
        <div className="flex items-center gap-2">
          <LanguageMenu />
          {merchants.length > 1 && (
            <select
              value={merchantId}
              onChange={(e) => setMerchantId(e.target.value)}
              disabled={locked}
              aria-label={t("portal.merchant")}
              className="max-w-[10rem] rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
            >
              {merchants.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.business_name} · {m.terminal_id}
                </option>
              ))}
            </select>
          )}
        </div>
      </header>

      {error && <div className="rounded-lg bg-rose-500/15 p-3 text-sm text-rose-300">{error}</div>}

      {merchantId && (
        <TerminalPanel key={merchantId} merchantId={merchantId} merchantName={merchant?.business_name} category={merchant?.category} routing={merchant?.routing} onActiveChange={setLocked} />
      )}
    </main>
  );
}
