"use client";

import { useEffect } from "react";

/** Registers the offline-fallback service worker (production only, so dev reloads are never intercepted). */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);
  return null;
}
