"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { ArrowLeft, Printer } from "lucide-react";
import { LanguageMenu } from "@/components/LanguageMenu";
import { printPage } from "@/lib/native";
import { useT } from "@/lib/i18n";

/**
 * A printable counter poster: big QR to the shop's scan-to-pay page, in English and Amharic together (a customer sees
 * both whatever the app language is). Only the poster is printed; the buttons are hidden on paper.
 */
export default function PosterPage({ params }: { params: Promise<{ terminal: string }> }) {
  const { terminal } = use(params);
  const t = useT();
  const [name, setName] = useState("");
  // The site address is only known in the browser. Reading it while rendering made the server and browser output differ.
  const [origin, setOrigin] = useState("");
  const url = origin ? `${origin}/t/${terminal}` : "";

  useEffect(() => {
    setOrigin(window.location.origin);
    fetch(`/api/public/terminal/${terminal}`)
      .then((r) => r.json())
      .then((d) => setName(d.business_name ?? ""))
      .catch(() => {});
  }, [terminal]);

  return (
    <div className="min-h-screen bg-slate-100 p-4 text-slate-900">
      <div className="no-print mx-auto mb-4 flex max-w-xl items-center justify-between gap-3">
        <Link href="/dashboard/merchant?tab=accounts" className="inline-flex items-center gap-1.5 text-sm text-slate-600">
          <ArrowLeft className="h-4 w-4" /> {t("common.back")}
        </Link>
        <LanguageMenu variant="light" />
        <button onClick={printPage} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 font-bold text-white">
          <Printer className="h-4 w-4" /> {t("common.print")}
        </button>
      </div>

      <div id="print-area" className="mx-auto flex max-w-xl flex-col items-center gap-5 rounded-3xl bg-white p-10 text-center shadow-lg">
        <div className="text-3xl font-black tracking-tight text-emerald-700">2Pay</div>
        <h1 className="text-4xl font-extrabold leading-tight">
          Scan to pay
          <span className="mt-1 block text-3xl">ለመክፈል ስካን ያድርጉ</span>
        </h1>
        <p className="text-lg text-slate-600">
          with any bank or wallet
          <span className="block">በማንኛውም ባንክ ወይም ቦርሳ</span>
        </p>
        <div className="rounded-3xl border-8 border-emerald-600 p-5">{url && <QRCodeSVG value={url} size={300} level="M" marginSize={0} />}</div>
        {name && <div className="text-2xl font-bold">{name}</div>}
        <p className="text-base text-slate-600">1. Scan · 2. Enter the amount · 3. Pay</p>
        <p className="text-base text-slate-600">1. ስካን ያድርጉ · 2. መጠኑን ያስገቡ · 3. ይክፈሉ</p>
        <p className="break-all font-mono text-xs text-slate-400">{url}</p>
      </div>
    </div>
  );
}
