"use client";

import { useEffect, useState } from "react";
import { Zap } from "lucide-react";
import type { Merchant } from "@/lib/types";
import { TerminalPanel } from "@/components/TerminalPanel";

export default function TerminalPage() {
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [merchantId, setMerchantId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

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

  const merchant = merchants.find((m) => m.id === merchantId);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-4">
      <header className="flex items-center justify-between pt-2">
        <div className="flex items-center gap-2 text-brand">
          <Zap className="h-5 w-5" /> <span className="font-semibold">2Pay Terminal</span>
        </div>
        <select
          value={merchantId}
          onChange={(e) => setMerchantId(e.target.value)}
          disabled={locked}
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

      {merchantId && (
        <TerminalPanel
          key={merchantId}
          merchantId={merchantId}
          merchantName={merchant?.business_name}
          category={merchant?.category}
          onActiveChange={setLocked}
        />
      )}
    </main>
  );
}
