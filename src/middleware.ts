import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import { normalizeWalletNumber } from "@/lib/settlement";

/**
 * Two jobs, in this order.
 *
 * 1. CROSS-SITE REQUEST GUARD (always on). A request that CHANGES something (POST, PUT, PATCH, DELETE) to our API is refused
 *    if the browser says it comes from another website (an `Origin` that is not ours, or `Sec-Fetch-Site: cross-site`). Session
 *    cookies are already SameSite, so this is a second lock: even a bug elsewhere cannot let a page on another site act as a
 *    signed-in merchant. Server-to-server callers (payment providers, the scheduler) send no Origin and are not affected.
 *
 * 2. SESSION GATE for the merchant-facing surface. A NO-OP unless AUTH_ENFORCED=true, so during the test phase anyone with
 *    the link reaches the terminal and every dashboard. When enforced: a valid signed session is required for the pages and
 *    APIs below; the admin dashboards (/dashboard and /dashboard/admin) additionally need a phone listed in ADMIN_PHONES. The
 *    API routes themselves also check ownership (a merchant can only read or change their own data), so this is defence in depth.
 *
 * Payer-facing routes (/pay, /api/pay, ads impression/click), provider webhooks, /api/auth, the cron job and the
 * secret-protected /api/watchdog/ingest are deliberately outside the session gate: they authenticate themselves.
 */
const isAdminPage = (path: string) => path === "/dashboard" || path === "/dashboard/" || path.startsWith("/dashboard/admin");

const isAdmin = (phone: string) =>
  (process.env.ADMIN_PHONES ?? "")
    .split(",")
    .map((p) => normalizeWalletNumber(p.trim()))
    .includes(phone);

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Called by other servers (never by a browser page), so there is no Origin to check; they authenticate with signatures or secrets. */
const SERVER_TO_SERVER = ["/api/webhooks/", "/api/cron/", "/api/watchdog/ingest"];

const crossSite = (req: NextRequest) => {
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== req.nextUrl.host) return true;
    } catch {
      return true; // an Origin we cannot read is not one we trust
    }
  }
  return req.headers.get("sec-fetch-site") === "cross-site";
};

const needsSession = (path: string) =>
  path.startsWith("/dashboard") ||
  path === "/terminal" ||
  path.startsWith("/api/merchants") ||
  path.startsWith("/api/transactions") ||
  path === "/api/team/ledger" ||
  path === "/api/ads/campaigns" ||
  path === "/api/watchdog" ||
  path.startsWith("/api/admin") ||
  path === "/api/portal";

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;

  if (path.startsWith("/api/") && UNSAFE.has(req.method) && !SERVER_TO_SERVER.some((p) => path.startsWith(p)) && crossSite(req)) {
    return NextResponse.json({ error: "Cross-site requests are not allowed" }, { status: 403 });
  }

  if (process.env.AUTH_ENFORCED !== "true" || !needsSession(path)) return NextResponse.next();

  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, process.env.SESSION_SECRET);

  if (session) {
    if (isAdminPage(path) && !isAdmin(session.ph)) {
      const url = req.nextUrl.clone();
      url.pathname = "/dashboard/merchant";
      url.search = "";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  if (path.startsWith("/api/")) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/signin";
  url.search = `?next=${encodeURIComponent(path + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Every API request passes the cross-site guard; pages are only matched where a session may be needed.
  matcher: ["/api/:path*", "/dashboard/:path*", "/terminal"],
};
