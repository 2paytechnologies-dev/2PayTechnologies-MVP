import { supabase } from "@/lib/supabase";
import type { Transaction } from "@/lib/types";

const PAGE = 1000;

/**
 * Every transaction for a merchant in [fromISO, toISO), newest first, paged past PostgREST's
 * 1000-row response cap. `truncated` is true if `maxRows` stopped the walk early.
 */
export async function fetchTransactions(
  merchantId: string,
  fromISO: string,
  toISO: string,
  maxRows = 20_000,
): Promise<{ rows: Transaction[]; truncated: boolean }> {
  const rows: Transaction[] = [];
  for (let offset = 0; offset < maxRows; offset += PAGE) {
    const { data, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("merchant_id", merchantId)
      .gte("created_at", fromISO)
      .lt("created_at", toISO)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false }) // stable tiebreak so pages never overlap
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...((data as Transaction[]) ?? []));
    if (!data || data.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}
