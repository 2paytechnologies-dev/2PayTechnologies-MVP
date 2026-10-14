import type { Merchant } from "@/lib/types";

export type Role = "OWNER" | "CASHIER" | "WAITER" | "MANAGER";

export interface SessionInfo {
  enforced: boolean;
  merchant: { id: string; business_name: string; terminal_id: string } | null;
  role: Role;
  admin: boolean;
  railMode: "simulated" | "live";
  /** The signed-in team member (waiter / cashier / manager), if any. */
  staff: { id: string; name: string; team_no: string | null } | null;
}

const toRole = (r: unknown): Role => (r === "CASHIER" || r === "WAITER" || r === "MANAGER" ? r : "OWNER");

function parseSession(d: Record<string, unknown>): SessionInfo {
  return {
    enforced: !!d.enforced,
    merchant: (d.merchant as SessionInfo["merchant"]) ?? null,
    role: toRole(d.role),
    admin: !!d.admin,
    railMode: d.railMode === "live" ? "live" : "simulated",
    staff: (d.staff as SessionInfo["staff"]) ?? null,
  };
}

/** Who is signed in (if anyone). Never throws: anonymous and test-mode visitors simply get merchant = null. */
export async function fetchSession(): Promise<SessionInfo> {
  try {
    const r = await fetch("/api/auth/me", { cache: "no-store" });
    return parseSession(await r.json());
  } catch {
    return { enforced: false, merchant: null, role: "OWNER", admin: false, railMode: "simulated", staff: null };
  }
}

/** Pick the signed-in merchant from a list, falling back to the first entry. */
export async function defaultMerchantId(list: { id: string }[]): Promise<string> {
  const { merchant } = await fetchSession();
  return list.find((m) => m.id === merchant?.id)?.id ?? list[0].id;
}

// ------------------------------------------------------------------ the portal's first screen, in one request
export interface Portal {
  session: SessionInfo;
  merchants: Merchant[];
  defaultMerchantId: string;
}

const CACHE_KEY = "2pay:portal:v1";

/**
 * What was on screen last time (business names, terminal ids and the NAMES of the active institutions: nothing secret).
 * Painting it at once lets the app open instantly; the live answer then replaces it a moment later.
 */
export function cachedPortal(): Portal | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Portal;
    return Array.isArray(p.merchants) && p.merchants.length && p.session ? p : null;
  } catch {
    return null;
  }
}

export function forgetPortal() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

let inFlight: Promise<Portal | null> | null = null;

/** One request for session + businesses + default business. Concurrent callers share it. Resolves null if the server refused. */
export function fetchPortal(): Promise<Portal | null> {
  if (inFlight) return inFlight;
  inFlight = fetch("/api/portal", { cache: "no-store" })
    .then(async (r) => {
      const d = await r.json().catch(() => ({}));
      if (r.status === 401) {
        forgetPortal();
        return null;
      }
      if (!r.ok || !Array.isArray(d.merchants)) throw new Error(d.error ?? "portal");
      const portal: Portal = { session: parseSession(d), merchants: d.merchants as Merchant[], defaultMerchantId: String(d.defaultMerchantId ?? "") };
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(portal));
      } catch {
        /* storage full or blocked: the next open simply waits for the network */
      }
      return portal;
    })
    .finally(() => {
      // allow a fresh request next time, but let callers in the same tick share this one
      setTimeout(() => (inFlight = null), 300);
    });
  return inFlight;
}
