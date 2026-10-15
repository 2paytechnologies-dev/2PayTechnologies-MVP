"use client";

import { useEffect, useState } from "react";
import type { WatchdogEvent } from "@/lib/types";
import { EMPTY_STATS, type DayStats, type NodeFee } from "@/lib/admin-types";

export type AdminEvent = WatchdogEvent & { business_name?: string | null; terminal_id?: string | null };

export interface Overview {
  stats: DayStats;
  nodes: NodeFee[];
  events: AdminEvent[];
  /** Error loading the totals (blocks the dashboard). */
  error: string | null;
  /** Error loading watchdog events only (the rest still works). */
  eventsError: string | null;
  loaded: boolean;
}

/**
 * Polls /api/admin/overview, which checks the admin role server-side. The totals come from the database already added up, so the
 * browser never downloads sales or merchant lists and never needs database credentials.
 */
export function useOverview(intervalMs = 5000): Overview {
  const [state, setState] = useState<Overview>({ stats: EMPTY_STATS, nodes: [], events: [], error: null, eventsError: null, loaded: false });

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
          stats: data.stats ?? EMPTY_STATS,
          nodes: data.nodes ?? [],
          events: data.events ?? [],
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
