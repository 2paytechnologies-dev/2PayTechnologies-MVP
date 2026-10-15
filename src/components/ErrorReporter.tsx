"use client";

import { apiUrl } from "@/lib/api-base";

import { useEffect } from "react";
import { nativeInfo } from "@/lib/native";

/** Send one error report to the server (fire and forget; telemetry must never cause errors of its own). */
export function reportError(message: string, stack?: string) {
  try {
    const body = JSON.stringify({ message, stack, url: location.pathname, source: nativeInfo() ? "android" : "web" });
    if (!navigator.sendBeacon?.(apiUrl("/api/telemetry/error"), new Blob([body], { type: "application/json" }))) {
      void fetch("/api/telemetry/error", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true });
    }
  } catch {
    /* ignore */
  }
}

/** Reports uncaught browser errors and unhandled promise rejections, so problems surface before a merchant has to call. */
export function ErrorReporter() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => reportError(e.message || "Unknown error", e.error?.stack);
    const onRejection = (e: PromiseRejectionEvent) => reportError(`Unhandled rejection: ${String(e.reason?.message ?? e.reason)}`, e.reason?.stack);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
