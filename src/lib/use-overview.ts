"use client";

import { useEffect, useState } from "react";
import type { Merchant, Transaction, WatchdogEvent } from "@/lib/types";

export interface Overview {
  transactions: Transaction[];
  events: WatchdogEvent[];
  merchants: Merchant[];
  /** Error loading transactions/merchants (blocks the dashboard). */
  error: string | null;
  /** Error loading watchdog events only (the rest still works). */
  eventsError: string | null;
  loaded: boolean;
}

/**
 * Polls /api/admin/overview, which checks the admin role server-side. Replaces the old direct database reads
 * and Realtime subscriptions, so the browser never needs database credentials.
 */
export function useOverview(intervalMs = 5000): Overview {
  const [state, setState] = useState<Overview>({ transactions: [], events: [], merchants: [], error: null, eventsError: null, loaded: false });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/admin/overview", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setState((s) => ({ ...s, error: data.error ?? "Could not load the overview", loaded: true }));
          return;
        }
        setState({
          transactions: data.transactions ?? [],
          events: data.events ?? [],
          merchants: data.merchants ?? [],
          error: null,
          eventsError: data.eventsError ? `Watchdog feed unavailable (${data.eventsError}). Run the latest migrations in supabase/.` : null,
          loaded: true,
        });
      } catch {
        if (!cancelled) setState((s) => ({ ...s, error: "Cannot reach the server", loaded: true }));
      }
    };
    void load();
    const id = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return state;
}
