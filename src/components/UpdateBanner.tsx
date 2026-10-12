"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { nativeInfo } from "@/lib/native";
import { updateState, type LatestApp, type UpdateState } from "@/lib/version";
import { useT } from "@/lib/i18n";

/**
 * Inside the Android app only: compares the installed version with /downloads/latest.json and asks the merchant to
 * update. "available" can be dismissed; "required" (older than minVersion) cannot, because that build is no longer
 * safe or compatible enough to take payments.
 */
export function UpdateBanner() {
  const t = useT();
  const [state, setState] = useState<{ s: UpdateState; latest: LatestApp } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const info = nativeInfo();
    if (!info) return; // a normal browser always runs the newest web code
    fetch("/downloads/latest.json", { cache: "no-store" })
      .then((r) => r.json())
      .then((latest: LatestApp) => setState({ s: updateState(info.version, latest), latest }))
      .catch(() => {});
  }, []);

  if (!state || state.s === "current" || (state.s === "available" && dismissed)) return null;
  const required = state.s === "required";
  return (
    <div className={`mb-4 flex flex-wrap items-center gap-3 rounded-2xl border p-4 text-sm ${required ? "border-rose-500/50 bg-rose-500/10 text-rose-100" : "border-sky-500/40 bg-sky-500/10 text-sky-100"}`}>
      <Download className="h-5 w-5 shrink-0" />
      <div className="min-w-[12rem] flex-1">
        <div className="font-semibold">{t("portal.updates.title", { version: state.latest.version })}</div>
        {required && <div className="text-xs opacity-90">{t("portal.updates.required")}</div>}
      </div>
      <a href={state.latest.apk} className="rounded-xl bg-white px-4 py-2 font-bold text-slate-900">
        {t("portal.updates.cta")}
      </a>
      {!required && (
        <button onClick={() => setDismissed(true)} className="text-xs underline opacity-80">
          {t("portal.updates.later")}
        </button>
      )}
    </div>
  );
}
