/** What the admin hub receives. The totals are computed in the database, so they are right at any volume. */
export interface SourceStats {
  taps: number;
  gmv: number;
  avg_latency_ms: number | null;
  nodes: number;
}

export interface DayStats {
  gmv: number;
  taps: number;
  settled: number;
  avg_latency_ms: number | null;
  /** keyed by where the sale started: TERMINAL, RIDE, STATIC_QR */
  by_source: Record<string, SourceStats>;
  fees: { base: number; vat: number; net: number; priced_taps: number; legacy_taps: number };
}

export interface NodeFee {
  merchant_id: string;
  business: string;
  terminal: string;
  taps: number;
  gmv: number;
  base: number;
  vat: number;
  net: number;
  legacy: number;
  /** Average Watchdog risk over the recent signals for this node (context only: it does not change the price). */
  risk: number;
  signals: number;
}

export const EMPTY_STATS: DayStats = { gmv: 0, taps: 0, settled: 0, avg_latency_ms: null, by_source: {}, fees: { base: 0, vat: 0, net: 0, priced_taps: 0, legacy_taps: 0 } };
