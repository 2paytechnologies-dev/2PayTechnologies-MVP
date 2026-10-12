"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { LanguageMenu } from "@/components/LanguageMenu";
import { Logo } from "@/components/Logo";
import { useI18n } from "@/lib/i18n";
import { LEGAL } from "@/lib/i18n/legal-text";

/** Renders the Terms or the Privacy Policy in the visitor's language. */
export function LegalPage({ doc }: { doc: "terms" | "privacy" }) {
  const { lang, t } = useI18n();
  const d = LEGAL[lang][doc];
  const contact = process.env.NEXT_PUBLIC_LEGAL_CONTACT;
  return (
    <main className="mx-auto max-w-2xl space-y-6 p-5 pb-16">
      <header className="flex items-center justify-between gap-3">
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-slate-400">
          <ArrowLeft className="h-4 w-4" /> {t("common.back")}
        </Link>
        <LanguageMenu />
      </header>
      <div className="flex items-center gap-2 text-brand">
        <Logo /> <h1 className="text-2xl font-bold text-white">{d.title}</h1>
      </div>
      <p className="text-xs text-slate-500">
        {d.updated} · <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">{d.draftNote}</span>
      </p>
      {d.sections.map((s) => (
        <section key={s.title} className="space-y-2">
          <h2 className="text-lg font-semibold">{s.title}</h2>
          {s.body.map((p, i) => (
            <p key={i} className="text-sm leading-relaxed text-slate-300">
              {p}
            </p>
          ))}
        </section>
      ))}
      {contact && <p className="text-sm text-slate-400">{contact}</p>}
    </main>
  );
}
