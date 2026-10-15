/**
 * Which part of 2Pay this deployment is. The same code runs three ways, chosen by DEPLOY_ROLE:
 *
 *   all   (default) the whole app in one place: today's single deployment.
 *   ui    the screens only (for example on Vercel). It holds NO database credentials, answers no /api request, and never touches a sale,
 *         an account or a person's record, so no transaction data passes through or rests on it.
 *   core  the in-country server: the API and the database connection. Every sale, account, key, KYC record and audit entry lives and
 *         is handled here. (It can also serve the screens, but the point is that it holds the data.)
 *
 * The browser talks to the core directly (NEXT_PUBLIC_API_BASE), so transaction data never goes through the UI host.
 */
export type DeployRole = "all" | "ui" | "core";

export function deployRole(env: Record<string, string | undefined> = process.env): DeployRole {
  const r = (env.DEPLOY_ROLE ?? "all").toLowerCase();
  return r === "ui" || r === "core" ? r : "all";
}

/** The UI deployment must never reach data: used by the database client as a last line of defence. */
export const dataAllowed = (env: Record<string, string | undefined> = process.env) => deployRole(env) !== "ui";

/** The browser origins allowed to call this API (the UI host), from UI_ORIGINS="https://app.example.et,https://www.example.et". */
export function uiOrigins(env: Record<string, string | undefined> = process.env): string[] {
  return (env.UI_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter((o) => /^https?:\/\/[^/\s]+$/.test(o));
}

/** Cookie settings for a UI and an API on different hosts: COOKIE_DOMAIN=.example.et makes the sign-in cookie reach both. */
export function cookieShare(env: Record<string, string | undefined> = process.env): { domain?: string } {
  const d = (env.COOKIE_DOMAIN ?? "").trim();
  return /^\.?[a-z0-9.-]+$/i.test(d) && d.includes(".") ? { domain: d } : {};
}
