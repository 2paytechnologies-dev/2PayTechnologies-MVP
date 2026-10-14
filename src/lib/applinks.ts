import type { Transfer } from "@/lib/routing-hub";

/**
 * Opening the customer's own bank or wallet app straight onto the right transfer screen, pre-filled.
 *
 * Nothing about any app's link format is built in: each institution's real link scheme (and Android package) comes from
 * that institution, so the operator supplies them in RAIL_APP_LINKS, keyed by the CUSTOMER's app name. Because paying a
 * merchant at the SAME bank is a different screen from paying one at ANOTHER bank (the "Transfer to other banks" screen
 * every bank app has through EthSwitch), an app can have a template for each kind of transfer:
 *
 *   {
 *     "Awash Bank": {
 *       "internal":  { "android": "...", "ios": "...", "any": "..." },   // the merchant is also at Awash
 *       "interbank": { "android": "intent://other-bank?bank={bank_code}&acct={account}&amt={amount}#Intent;scheme=<theirs>;package=<theirs>;S.browser_fallback_url={url};end",
 *                      "ios":     "<theirs>://other-bank?bank={bank_code}&acct={account}&amt={amount}" },
 *       "wallet":    { "any": "..." },                                  // the merchant is a wallet
 *       "any": "https://<their web link>?pay={url}"                     // used when no template fits
 *     },
 *     "Telebirr": "https://<their universal link>?pay={url}"           // one template for everything
 *   }
 *
 * Placeholders (URL-encoded when filled in): {url} the rail's payment page, {account} the merchant's account number or wallet
 * number, {bank} the merchant's bank or wallet name, {bank_code} its EthSwitch bank code (from ETS_BANK_CODES), {name} the
 * merchant's name, {payload} the ETHQR payload, {amount}, {ref}. A template whose placeholders cannot all be filled is skipped,
 * and if no link fits, or the app does not open, the pay page carries on to the web checkout, so a wrong or missing link
 * never blocks a payment.
 */
export type Platform = "android" | "ios" | "other";

export const platformOf = (userAgent: string | null | undefined): Platform => (/Android/i.test(userAgent ?? "") ? "android" : /iPhone|iPad|iPod/i.test(userAgent ?? "") ? "ios" : "other");

export interface LinkVars {
  url: string;
  payload?: string | null;
  amount?: string;
  ref?: string;
  account?: string | null;
  bank?: string | null;
  bank_code?: string | null;
  name?: string | null;
}

const BLOCKED = /^(javascript|data|file|vbscript|blob|about):/i;
const scheme = /^[a-z][a-z0-9+.-]*:/i;
const PLACEHOLDER = /\{(url|payload|amount|ref|account|bank|bank_code|name)\}/g;

export function usableTemplate(t: unknown): t is string {
  return typeof t === "string" && t.length < 2000 && scheme.test(t) && !BLOCKED.test(t.trim());
}

/** Fill a template. Returns undefined when it needs a placeholder we do not have. */
export function fillTemplate(template: string, vars: LinkVars): string | undefined {
  let missing = false;
  const out = template.replace(PLACEHOLDER, (_, k: keyof LinkVars) => {
    const v = vars[k];
    if (v == null || v === "") {
      missing = true;
      return "";
    }
    return encodeURIComponent(v);
  });
  return missing ? undefined : out;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The templates to try, most specific first: this transfer on this phone, this transfer anywhere, then the app's general ones. */
function candidates(entry: unknown, platform: Platform, kind?: Transfer): unknown[] {
  if (typeof entry === "string") return [entry];
  if (!isObj(entry)) return [];
  const forKind = kind ? entry[kind] : undefined;
  const pick = (e: unknown) => (typeof e === "string" ? [e] : isObj(e) ? [e[platform], e.any] : []);
  return [...pick(forKind), ...pick(entry)];
}

/** The link to open `app` on this phone for this kind of transfer, or undefined if none is configured (or usable). */
export function resolveAppLink(rawConfig: string | undefined, app: string, platform: Platform, vars: LinkVars, kind?: Transfer): string | undefined {
  let entry: unknown;
  try {
    entry = (JSON.parse(rawConfig ?? "{}") as Record<string, unknown>)[app];
  } catch {
    return undefined;
  }
  for (const c of candidates(entry, platform, kind)) {
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

/** Is any link configured at all for this app? (So the merchant's account is only read when it could be used.) */
export function hasLinks(rawConfig: string | undefined, app: string): boolean {
  try {
    return (JSON.parse(rawConfig ?? "{}") as Record<string, unknown>)[app] != null;
  } catch {
    return false;
  }
}

/** EthSwitch bank codes from ETS_BANK_CODES={"Awash Bank":"<code>"} (never built in: the codes come from EthSwitch). */
export function bankCodeFor(institution: string, raw: string | undefined = process.env.ETS_BANK_CODES): string | null {
  try {
    const v = (JSON.parse(raw ?? "{}") as Record<string, unknown>)[institution];
    return typeof v === "string" && v.length < 20 ? v : null;
  } catch {
    return null;
  }
}
