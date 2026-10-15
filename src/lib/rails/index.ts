import { arifpay } from "./arifpay";
import type { RailAdapter } from "./types";

export * from "./types";

/** Register new rails here. The key is the provider id used in /api/webhooks/[provider]. */
const ADAPTERS: Record<string, RailAdapter> = {
  [arifpay.id]: arifpay,
};

/**
 * simulated: payers are "authorized" instantly with no money movement (demos and pilots of the UX only).
 * live:      payers are sent to the provider; only a verified provider callback can mark a sale settled.
 */
export type RailMode = "simulated" | "live";
export const railMode = (): RailMode => (process.env.RAIL_MODE === "live" ? "live" : "simulated");

export const getAdapter = (id: string): RailAdapter | null => ADAPTERS[id] ?? null;
export const registeredIds = (): string[] => Object.keys(ADAPTERS);

/** The provider new payments are routed to. */
export function activeAdapter(): RailAdapter {
  const id = process.env.RAIL_PROVIDER ?? "arifpay";
  const a = ADAPTERS[id];
  if (!a) throw new Error(`Unknown RAIL_PROVIDER "${id}". Registered: ${Object.keys(ADAPTERS).join(", ")}`);
  return a;
}

/**
 * Public origin for success/cancel/notify URLs. Taken from configuration, never from the request's Host header,
 * so a spoofed header can't redirect payers or provider callbacks elsewhere.
 */
/**
 * Where payment providers send their callbacks: the API server (the in-country core when the screens and the API are split), taken from
 * configuration like publicBaseUrl. Defaults to the same address as the screens.
 */
export function apiBaseUrl(): string {
  const configured = process.env.API_BASE_URL;
  return configured ? configured.replace(/\/$/, "") : publicBaseUrl();
}

export function publicBaseUrl(): string {
  const configured = process.env.PUBLIC_BASE_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");
  if (configured) return configured.replace(/\/$/, "");
  if (process.env.NODE_ENV !== "production") return "http://localhost:3000";
  throw new Error("PUBLIC_BASE_URL is not configured");
}
