"use client";

import Link from "next/link";
import { Briefcase, Download, LayoutDashboard, LogIn, ShieldAlert, Smartphone } from "lucide-react";
import { Logo } from "@/components/Logo";
import { LanguageMenu } from "@/components/LanguageMenu";
import { useT, type Key } from "@/lib/i18n";

const LINKS: { href: string; icon: typeof LogIn; title: Key; body: Key }[] = [
  { href: "/signin", icon: LogIn, title: "home.signin.title", body: "home.signin.body" },
  { href: "/dashboard/merchant", icon: Briefcase, title: "home.portal.title", body: "home.portal.body" },
  { href: "/download", icon: Download, title: "home.download.title", body: "home.download.body" },
  { href: "/dashboard/admin", icon: ShieldAlert, title: "home.admin.title", body: "home.admin.body" },
  { href: "/dashboard", icon: LayoutDashboard, title: "home.exec.title", body: "home.exec.body" },
];

export default function Home() {
  const t = useT();
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6 py-16">
      <div>
        <div className="mb-3 flex items-center gap-2 text-brand">
          <Logo />
          <span className="text-sm font-semibold uppercase tracking-widest">2Pay Technologies</span>
          <LanguageMenu className="ml-auto" />
        </div>
        <h1 className="text-4xl font-bold">{t("home.tagline")}</h1>
        <p className="mt-3 text-slate-400">{t("home.sub")}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {LINKS.map(({ href, icon: Icon, title, body }) => (
          <Link key={href} href={href} className="rounded-2xl border border-slate-800 bg-slate-900 p-5 transition hover:border-brand">
            <Icon className="mb-3 h-6 w-6 text-brand" />
            <div className="font-semibold">{t(title)}</div>
            <p className="mt-1 text-sm text-slate-400">{t(body)}</p>
          </Link>
        ))}
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <Smartphone className="mb-3 h-6 w-6 text-brand" />
          <div className="font-semibold">{t("home.customer.title")}</div>
          <p className="mt-1 text-sm text-slate-400">{t("home.customer.body")}</p>
        </div>
      </div>
      <p className="text-center text-xs text-slate-600">
        <Link href="/terms" className="underline">
          {t("common.legal")}
        </Link>
        {" · "}
        <Link href="/privacy" className="underline">
          {t("common.privacy")}
        </Link>
      </p>
    </main>
  );
}
