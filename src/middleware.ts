import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import { normalizeWalletNumber } from "@/lib/settlement";
import { deployRole, uiOrigins } from "@/lib/deploy";

/**
 * Four jobs, in this order.
 *
 * 0. DEPLOYMENT ROLE. A screens-only deployment (DEPLOY_ROLE=ui, for example on Vercel) answers no /api request at all (except /api/health), so
 *    no transaction data can pass through it. The API lives on the in-country server, and the browser calls it directly.
 *
 * 1. CROSS-SITE REQUEST GUARD (always on). A request that CHANGES something (POST, PUT, PATCH, DELETE) to our API is refused
 *    if the browser says it comes from another website (an `Origin` that is not ours, or `Sec-Fetch-Site: cross-site`). Session
 *    cookies are already SameSite, so this is a second lock: even a bug elsewhere cannot let a page on another site act as a
 *    signed-in merchant. Server-to-server callers (payment providers, the scheduler) send no Origin and are not affected.
 *    The one allowed exception is the 2Pay screens host itself (UI_ORIGINS), which calls the API from a different address.
 *
 * 2. CORS for that screens host: only the origins listed in UI_ORIGINS may read API answers from a browser, with cookies.
 *
 * 3. SESSION GATE for the merchant-facing surface. A NO-OP unless AUTH_ENFORCED=true, so during the test phase anyone with
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
const SERVER_TO_SERVER = ["/api/webhooks/", "/api/cron/", "/api/watchdog/ingest", "/api/ai/"];

/** True when the browser says this request comes from some other website. `trusted` is the screens host from UI_ORIGINS, which is allowed. */
const crossSite = (req: NextRequest, trusted: string | null) => {
  if (trusted) return false;
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
  path.startsWith("/api/kyc") ||
  path === "/api/portal";

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const isApi = path.startsWith("/api/");

  // The screens host that is allowed to call this API from a browser (never anyone else).
  const origin = req.headers.get("origin")?.replace(/\/$/, "") ?? null;
  const trusted = origin && uiOrigins().includes(origin) ? origin : null;
  const cors = (res: NextResponse) => {
    if (isApi && trusted) {
      res.headers.set("Access-Control-Allow-Origin", trusted);
      res.headers.set("Access-Control-Allow-Credentials", "true");
      res.headers.append("Vary", "Origin");
    }
    return res;
  };

  if (isApi && deployRole() === "ui" && path !== "/api/health") {
    return NextResponse.json({ error: "This is the screens-only deployment. The 2Pay API runs on the core server." }, { status: 404 });
  }

  if (isApi && req.method === "OPTIONS" && trusted) {
    return cors(new NextResponse(null, { status: 204, headers: { "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Max-Age": "600" } }));
  }

  if (isApi && UNSAFE.has(req.method) && !SERVER_TO_SERVER.some((p) => path.startsWith(p)) && crossSite(req, trusted)) {
    return NextResponse.json({ error: "Cross-site requests are not allowed" }, { status: 403 });
  }

  // A ride-hailing checkout link (/terminal?session_token=...) opens the driver's phone with no 2Pay sign-in: the long random token
  // in the link is the credential, and every call that page makes is authorised by that token (see /api/v1/integrations/ride-hailing).
  if (path === "/terminal" && req.nextUrl.searchParams.has("session_token")) return NextResponse.next();

  if (process.env.AUTH_ENFORCED !== "true" || !needsSession(path)) return cors(NextResponse.next());

  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, process.env.SESSION_SECRET);

  if (session) {
    if (isAdminPage(path) && !isAdmin(session.ph)) {
      const url = req.nextUrl.clone();
      url.pathname = "/dashboard/merchant";
      url.search = "";
      return NextResponse.redirect(url);
    }
    return cors(NextResponse.next());
  }

  if (isApi) {
    return cors(NextResponse.json({ error: "Authentication required" }, { status: 401 }));
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
