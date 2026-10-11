import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import { normalizeWalletNumber } from "@/lib/settlement";

/**
 * Session gate for the merchant-facing surface. It is a NO-OP unless AUTH_ENFORCED=true, so during the test
 * phase anyone with the link reaches the terminal and every dashboard.
 *
 * When enforced: a valid signed session is required for the pages and APIs below; the admin dashboards
 * (/dashboard and /dashboard/admin) additionally need a phone listed in ADMIN_PHONES. The API routes themselves
 * also check ownership (a merchant can only read or change their own data), so this is defence in depth.
 *
 * Payer-facing routes (/pay, /api/pay, ads impression/click), provider webhooks, /api/auth, the cron job and the
 * secret-protected /api/watchdog/ingest are deliberately outside the matcher: they authenticate themselves.
 */
const isAdminPage = (path: string) => path === "/dashboard" || path === "/dashboard/" || path.startsWith("/dashboard/admin");

const isAdmin = (phone: string) =>
  (process.env.ADMIN_PHONES ?? "")
    .split(",")
    .map((p) => normalizeWalletNumber(p.trim()))
    .includes(phone);

export async function middleware(req: NextRequest) {
  if (process.env.AUTH_ENFORCED !== "true") return NextResponse.next();

  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, process.env.SESSION_SECRET);
  const path = req.nextUrl.pathname;

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
  matcher: [
    "/dashboard/:path*",
    "/terminal",
    "/api/merchants/:path*",
    "/api/transactions/:path*",
    "/api/ads/campaigns",
    "/api/watchdog",
    "/api/admin/:path*",
  ],
};
