/**
 * Opening the customer's own bank or wallet app straight from the pay page.
 *
 * Nothing about any app's link format is built in: each institution's real link scheme (and Android package) comes from
 * that institution, so the operator supplies them in RAIL_APP_LINKS, keyed by the app's name:
 *
 *   {
 *     "Telebirr": "https://<their universal link>?pay={url}",
 *     "CBE Birr": {
 *       "android": "intent://pay?data={payload}#Intent;scheme=<their scheme>;package=<their package>;S.browser_fallback_url={url};end",
 *       "ios":     "<their scheme>://pay?data={payload}",
 *       "any":     "https://<their web link>?pay={url}"
 *     }
 *   }
 *
 * Placeholders (URL-encoded when filled in): {url} the payment page of the rail, {payload} the ETHQR payload, {amount}, {ref}.
 * A template that needs {payload} is skipped when no payload could be built. If the app does not open, the pay page
 * carries on to the web checkout, so a wrong or missing link never blocks a payment.
 */
export type Platform = "android" | "ios" | "other";

export const platformOf = (userAgent: string | null | undefined): Platform => (/Android/i.test(userAgent ?? "") ? "android" : /iPhone|iPad|iPod/i.test(userAgent ?? "") ? "ios" : "other");

export interface LinkVars {
  url: string;
  payload?: string | null;
  amount?: string;
  ref?: string;
}

const BLOCKED = /^(javascript|data|file|vbscript|blob|about):/i;
const scheme = /^[a-z][a-z0-9+.-]*:/i;

export function usableTemplate(t: unknown): t is string {
  return typeof t === "string" && t.length < 2000 && scheme.test(t) && !BLOCKED.test(t.trim());
}

/** Fill a template. Returns undefined when it needs a placeholder we do not have. */
export function fillTemplate(template: string, vars: LinkVars): string | undefined {
  let missing = false;
  const out = template.replace(/\{(url|payload|amount|ref)\}/g, (_, k: keyof LinkVars) => {
    const v = vars[k];
    if (v == null || v === "") {
      missing = true;
      return "";
    }
    return encodeURIComponent(v);
  });
  return missing ? undefined : out;
}

/** The link to open `app` on this phone, or undefined if none is configured for it. */
export function resolveAppLink(rawConfig: string | undefined, app: string, platform: Platform, vars: LinkVars): string | undefined {
  let entry: unknown;
  try {
    entry = (JSON.parse(rawConfig ?? "{}") as Record<string, unknown>)[app];
  } catch {
    return undefined;
  }
  const candidates: unknown[] = typeof entry === "string" ? [entry] : entry && typeof entry === "object" ? [(entry as Record<string, unknown>)[platform], (entry as Record<string, unknown>).any] : [];
  for (const c of candidates) {
    if (!usableTemplate(c)) continue;
    // An Android intent: link only means something on Android.
    if (/^intent:/i.test(c) && platform !== "android") continue;
    const filled = fillTemplate(c, vars);
    if (filled) return filled;
  }
  return undefined;
}

/** Does any configured template for this app need the ETHQR payload? (So we only build it when it will be used.) */
export function needsPayload(rawConfig: string | undefined, app: string): boolean {
  try {
    const entry = (JSON.parse(rawConfig ?? "{}") as Record<string, unknown>)[app];
    return JSON.stringify(entry ?? "").includes("{payload}");
  } catch {
    return false;
  }
}