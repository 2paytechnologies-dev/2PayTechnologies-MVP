export interface SessionInfo {
  enforced: boolean;
  merchant: { id: string; business_name: string; terminal_id: string } | null;
}

/** Who is signed in (if anyone). Never throws: anonymous and test-mode visitors simply get merchant = null. */
export async function fetchSession(): Promise<SessionInfo> {
  try {
    const r = await fetch("/api/auth/me", { cache: "no-store" });
    const d = await r.json();
    return { enforced: !!d.enforced, merchant: d.merchant ?? null };
  } catch {
    return { enforced: false, merchant: null };
  }
}

/** Pick the signed-in merchant from a list, falling back to the first entry. */
export async function defaultMerchantId(list: { id: string }[]): Promise<string> {
  const { merchant } = await fetchSession();
  return list.find((m) => m.id === merchant?.id)?.id ?? list[0].id;
}
