import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/session";

/**
 * Session gate for the merchant-facing surface. It is a NO-OP unless AUTH_ENFORCED=true, so during the test
 * phase anyone with the link reaches the terminal and every dashboard.
 *
 * When enforced this checks only that a valid signed session exists. It does NOT yet restrict a merchant to
 * their own data (no ownership checks in the API routes) and /dashboard/admin has no admin role, so do not
 * treat enforcement as complete security until those are added.
 *
 * Payer-facing routes (/pay, /api/pay, ads impression/click), webhooks, /api/auth and the secret-protected
 * /api/watchdog/ingest are deliberately outside the matcher.
 */
export async function middleware(req: NextRequest) {
  if (process.env.AUTH_ENFORCED !== "true") return NextResponse.next();

  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, process.env.SESSION_SECRET);
  if (session) return NextResponse.next();

  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/signin";
  url.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/dashboard/:path*", "/terminal", "/api/merchants/:path*", "/api/transactions", "/api/ads/campaigns"],
};
