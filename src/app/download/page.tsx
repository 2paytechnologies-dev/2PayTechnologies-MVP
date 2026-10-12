"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { ArrowLeft, Download, ShieldCheck } from "lucide-react";
import { LanguageMenu } from "@/components/LanguageMenu";
import { Logo } from "@/components/Logo";
import { useT } from "@/lib/i18n";
import type { LatestApp } from "@/lib/version";

interface Latest extends LatestApp {
  sha256?: string;
  size?: number;
}

export default function DownloadPage() {
  const t = useT();
  const [latest, setLatest] = useState<Latest | null | "missing">(null);
  const [url, setUrl] = useState(""); // browser-only: reading window while rendering breaks hydration

  useEffect(() => {
    setUrl(window.location.href);
    fetch("/downloads/latest.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setLatest)
      .catch(() => setLatest("missing"));
  }, []);

  const steps = ["download.step1", "download.step2", "download.step3", "download.step4"] as const;

  return (
    <main className="mx-auto max-w-lg space-y-6 p-5 pb-16">
      <header className="flex items-center justify-between">
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-slate-400">
          <ArrowLeft className="h-4 w-4" /> {t("common.back")}
        </Link>
        <LanguageMenu />
      </header>

      <div className="space-y-2 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center text-brand">
          <Logo />
        </div>
        <h1 className="text-2xl font-bold">{t("download.title")}</h1>
        <p className="text-slate-400">{t("download.sub")}</p>
      </div>

      {latest && latest !== "missing" ? (
        <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-5 text-center">
          <div className="text-sm text-slate-400">{t("download.version", { v: latest.version })}</div>
          <a href={latest.apk} download className="flex h-14 items-center justify-center gap-2 rounded-2xl bg-brand text-lg font-bold text-slate-950">
            <Download className="h-5 w-5" /> {t("download.cta")}
          </a>
          <p className="text-xs text-slate-500">{t("download.requires")}</p>
          {latest.sha256 && (
            <p className="break-all text-left font-mono text-[10px] text-slate-600">
              <ShieldCheck className="mr-1 inline h-3 w-3" />
              {t("download.fingerprint")}: {latest.sha256}
            </p>
          )}
        </div>
      ) : (
        <p className="rounded-2xl border border-slate-800 bg-slate-900 p-5 text-center text-slate-500">{latest === null ? t("common.loading") : t("download.unavailable")}</p>
      )}

      <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="font-semibold">{t("download.steps.title")}</h2>
        <ol className="space-y-3 text-sm text-slate-300">
          {steps.map((k, i) => (
            <li key={k} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-700 text-xs font-bold">{i + 1}</span>
              <span>{t(k)}</span>
            </li>
          ))}
        </ol>
        <p className="border-t border-slate-800 pt-3 text-xs text-slate-500">{t("download.iphone")}</p>
      </section>

      {url && (
        <section className="flex items-center gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <div className="rounded-xl bg-white p-2.5">
            <QRCodeSVG value={url} size={96} level="M" marginSize={0} />
          </div>
          <p className="text-sm text-slate-300">{t("download.share")}</p>
        </section>
      )}
    </main>
  );
}
