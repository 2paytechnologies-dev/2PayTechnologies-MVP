"use client";

import { Globe } from "lucide-react";
import { LANGS, useI18n, type Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Language menu: English / አማርኛ. `dark` for the merchant screens, `light` for the payer's receipt.
 * The labels are written in each language's own script so anyone can find theirs.
 */
export function LanguageMenu({ variant = "dark", className }: { variant?: "dark" | "light"; className?: string }) {
  const { lang, setLang, t } = useI18n();
  const dark = variant === "dark";
  return (
    <label className={cn("inline-flex items-center gap-1.5 text-sm", dark ? "text-slate-400" : "text-slate-500", className)}>
      <Globe className="h-4 w-4 shrink-0" aria-hidden />
      <span className="sr-only">{t("common.language")}</span>
      <select
        value={lang}
        onChange={(e) => setLang(e.target.value as Lang)}
        aria-label={t("common.language")}
        className={cn(
          "cursor-pointer rounded-md border bg-transparent py-1 pl-1.5 pr-1 font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-brand",
          dark ? "border-slate-700 text-slate-200" : "border-slate-300 text-slate-700",
        )}
      >
        {LANGS.map((l) => (
          <option key={l.code} value={l.code} className="text-slate-900">
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}
