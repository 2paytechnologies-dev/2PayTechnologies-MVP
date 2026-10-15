/**
 * Where the browser finds the 2Pay API. Empty (the default) means the same address as the screens, which is how 2Pay runs today.
 * When the screens and the in-country API are on different hosts, set NEXT_PUBLIC_API_BASE (for example https://api.2pay.et) and every
 * request to /api/... from a browser goes there directly, with cookies, so no transaction data passes through the screens host.
 */
export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/+$/, "");

/** An /api/... path as the browser should request it. */
export const apiUrl = (path: string) => (API_BASE && path.startsWith("/api/") ? `${API_BASE}${path}` : path);

/**
 * Sends every browser fetch to /api/... to the API host (with cookies). Done once, here, so no screen needs to know where the API is.
 * A no-op when the screens and the API share an address.
 */
export function installApiBase() {
  if (typeof window === "undefined" || !API_BASE) return;
  const w = window as unknown as { __twopayApi?: boolean };
  if (w.__twopayApi) return;
  w.__twopayApi = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string" && input.startsWith("/api/")) return original(`${API_BASE}${input}`, { credentials: "include", ...init });
    return original(input, init);
  };
}
