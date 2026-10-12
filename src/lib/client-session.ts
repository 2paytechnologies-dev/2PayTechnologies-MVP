export interface SessionInfo {
  enforced: boolean;
  merchant: { id: string; business_name: string; terminal_id: string } | null;
  role: "OWNER" | "CASHIER";
  admin: boolean;
  railMode: "simulated" | "live";
}

/** Who is signed in (if anyone). Never throws: anonymous and test-mode visitors simply get merchant = null. */
export async function fetchSession(): Promise<SessionInfo> {
  try {
    const r = await fetch("/api/auth/me", { cache: "no-store" });
    const d = await r.json();
    return { enforced: !!d.enforced, merchant: d.merchant ?? null, role: d.role === "CASHIER" ? "CASHIER" : "OWNER", admin: !!d.admin, railMode: d.railMode === "live" ? "live" : "simulated" };
  } catch {
    return { enforced: false, merchant: null, role: "OWNER", admin: false, railMode: "simulated" };
  }
}

/** Pick the signed-in merchant from a list, falling back to the first entry. */
export async function defaultMerchantId(list: { id: string }[]): Promise<string> {
  const { merchant } = await fetchSession();
  return list.find((m) => m.id === merchant?.id)?.id ?? list[0].id;
}
