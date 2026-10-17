"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Download, Loader2 } from "lucide-react";
import { getNative, nativeInfo } from "@/lib/native";
import { updateState, type LatestApp, type UpdateState } from "@/lib/version";
import { useT } from "@/lib/i18n";

/** How often an open app asks whether a newer version has been published (it also asks each time the app comes back to the front). */
const RECHECK_MS = 30 * 60_000;

type Phase = "idle" | "working" | "permission" | "installing" | "saved" | "failed" | "checksum";

const toHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Inside the Android app only: compares the installed version with /downloads/latest.json and asks the merchant to update. It checks when the
 * screen opens, every time the app comes back to the front and every half hour, so a new release is announced without restarting the app.
 * "available" can be dismissed; "required" (older than minVersion) cannot, because that build is no longer safe or compatible enough to take payments.
 *
 * The Update button does the whole job:
 *  - app 2.7.0 or newer: the app downloads the APK, checks its SHA-256 and opens the system installer;
 *  - older apps (no installer in them): the page downloads the APK itself, checks its SHA-256 and saves it to Downloads, then tells the person to open it.
 */
export function UpdateBanner() {
  const t = useT();
  const [state, setState] = useState<{ s: UpdateState; latest: LatestApp } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");

  const check = useCallback(() => {
    const info = nativeInfo();
    if (!info) return; // a normal browser always runs the newest web code
    fetch("/downloads/latest.json", { cache: "no-store" })
      .then((r) => r.json())
      .then((latest: LatestApp) => setState({ s: updateState(info.version, latest), latest }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    check();
    const onShow = () => {
      if (!document.hidden) check();
    };
    document.addEventListener("visibilitychange", onShow);
    const timer = setInterval(check, RECHECK_MS);
    return () => {
      document.removeEventListener("visibilitychange", onShow);
      clearInterval(timer);
    };
  }, [check]);

  // Progress from the app's own installer (2.7.0 and newer).
  useEffect(() => {
    const on = (e: Event) => {
      const d = String((e as CustomEvent).detail ?? "");
      if (d === "downloading") setPhase("working");
      else if (d === "permission") setPhase("permission");
      else if (d === "installing") setPhase("installing");
      else if (d === "error:checksum") setPhase("checksum");
      else if (d.startsWith("error:")) setPhase("failed");
    };
    window.addEventListener("twopay:update", on);
    return () => window.removeEventListener("twopay:update", on);
  }, []);

  const update = async (latest: LatestApp) => {
    const n = getNative();
    const url = new URL(latest.apk, window.location.origin).toString();
    setPhase("working");
    try {
      if (n?.installUpdate && latest.sha256) {
        if (!n.installUpdate(url, latest.sha256)) setPhase("failed"); // refused, or an update is already running
        return;
      }
      if (n?.saveFile) {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const buf = await res.arrayBuffer();
        if (latest.sha256 && toHex(await crypto.subtle.digest("SHA-256", buf)) !== latest.sha256.toLowerCase()) return setPhase("checksum");
        const out = n.saveFile(latest.apk.split("/").pop() ?? "2pay-update.apk", "application/vnd.android.package-archive", toBase64(new Uint8Array(buf)));
        return setPhase(out.startsWith("ok:") ? "saved" : "failed");
      }
      window.location.href = latest.apk;
      setPhase("idle");
    } catch {
      setPhase("failed");
    }
  };

  if (!state || state.s === "current" || (state.s === "available" && dismissed)) return null;
  const required = state.s === "required";
  const busy = phase === "working" || phase === "installing";
  const note: Partial<Record<Phase, string>> = {
    working: t("portal.updates.working"),
    permission: t("portal.updates.permission"),
    installing: t("portal.updates.installing"),
    saved: t("portal.updates.saved"),
    failed: t("portal.updates.failed"),
    checksum: t("portal.updates.checksum"),
  };
  return (
    <div className={`mb-4 flex flex-wrap items-center gap-3 rounded-2xl border p-4 text-sm ${required ? "border-rose-500/50 bg-rose-500/10 text-rose-100" : "border-sky-500/40 bg-sky-500/10 text-sky-100"}`}>
      {phase === "saved" ? <CheckCircle2 className="h-5 w-5 shrink-0" /> : <Download className="h-5 w-5 shrink-0" />}
      <div className="min-w-[12rem] flex-1">
        <div className="font-semibold">{t("portal.updates.title", { version: state.latest.version })}</div>
        {required && phase === "idle" && <div className="text-xs opacity-90">{t("portal.updates.required")}</div>}
        {note[phase] && <div className="mt-0.5 text-xs opacity-90" role="status">{note[phase]}</div>}
      </div>
      {phase !== "saved" && (
        <button onClick={() => void update(state.latest)} disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2 font-bold text-slate-900 disabled:opacity-60">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("portal.updates.cta")}
        </button>
      )}
      {!required && phase !== "working" && (
        <button onClick={() => setDismissed(true)} className="text-xs underline opacity-80">
          {t("portal.updates.later")}
        </button>
      )}
    </div>
  );
}