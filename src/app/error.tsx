"use client";

import { useEffect } from "react";
import { reportError } from "@/components/ErrorReporter";
import { useT } from "@/lib/i18n";

/** Shown instead of a blank screen when a page crashes. The crash is reported so it can be fixed. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useT();
  useEffect(() => {
    reportError(error.message, error.stack);
  }, [error]);
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-bold">{t("common.errorGeneric")}</h1>
      <button onClick={reset} className="rounded-xl bg-brand px-6 py-3 font-bold text-slate-950">
        {t("common.retry")}
      </button>
    </main>
  );
}
