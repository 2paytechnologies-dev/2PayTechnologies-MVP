import type { Transaction } from "@/lib/types";

const PAGE = 1000;

/**
 * Every transaction for a merchant in [fromISO, toISO), newest first, fetched through /api/transactions
 * (which checks the session and ownership) in pages of 1000. `truncated` is true if `maxRows` stopped the walk early.
 */
export async function fetchTransactions(
  merchantId: string,
  fromISO: string,
  toISO: string,
  maxRows = 20_000,
): Promise<{ rows: Transaction[]; truncated: boolean }> {
  const rows: Transaction[] = [];
  for (let offset = 0; offset < maxRows; offset += PAGE) {
    const qs = new URLSearchParams({ merchant_id: merchantId, from: fromISO, to: toISO, limit: String(PAGE), offset: String(offset) });
    const res = await fetch(`/api/transactions?${qs}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "Could not load transactions");
    rows.push(...(data.rows as Transaction[]));
    if (!data.hasMore) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/** Count of a merchant's watchdog events of one type since `sinceISO` (via /api/watchdog). */
export async function countWatchdogEvents(merchantId: string, type: string, sinceISO: string): Promise<number> {
  const qs = new URLSearchParams({ merchant_id: merchantId, type, since: sinceISO });
  const res = await fetch(`/api/watchdog?${qs}`, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Could not load alerts");
  return Number(data.count ?? 0);
}
