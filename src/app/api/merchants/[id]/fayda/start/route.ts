import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireMerchant } from "@/lib/guard";
import { sessionSecret } from "@/lib/auth";
import { isUuid } from "@/lib/settlement";
import { audit, clientIp } from "@/lib/audit";
import { rateLimit } from "@/lib/ratelimit";
import { resolveApprover } from "@/lib/vault";
import { FAYDA_COOKIE, FAYDA_TTL_S, buildAuthorizeUrl, discover, faydaConfig, pkce, signState } from "@/lib/fayda";

export const dynamic = "force-dynamic";

const bad = (error: string, status = 400, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status });

/**
 * Begin "Verify with Fayda": returns the address of the national ID provider's sign-in page for the browser to open, and
 * remembers where we were (a signed, HttpOnly, 10-minute cookie holding the state, nonce and PKCE verifier). The owner, or a
 * manager the owner appointed, verifies themselves. Nothing happens until the provider is configured (FAYDA_* settings).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return bad("Malformed merchant id");
  const guard = await requireMerchant(id, { vault: true });
  if (!guard.ok) return guard.res;
  const cfg = faydaConfig();
  const secret = sessionSecret();
  if (!cfg || !secret) return bad("National ID verification is not set up yet.", 503, { code: "FAYDA_NOT_CONFIGURED" });
  const body = await req.json().catch(() => null);

  try {
    const admin = getAdminClient();
    if (!(await rateLimit(admin, `fayda:ip:${clientIp(req)}`, 10, 600, { failClosed: true }))) return bad("Too many attempts. Try again in a few minutes.", 429);
    const who = await resolveApprover(admin, id, guard.session);
    if (!who) return bad("Only the owner or a manager can verify their national ID here.", 403);

    const disc = await discover(cfg);
    const { verifier, challenge } = pkce();
    const state = randomUUID();
    const nonce = randomUUID();
    const url = buildAuthorizeUrl(cfg, disc, { state, nonce, challenge, lang: body?.lang === "am" ? "am" : "en" });
    await audit(admin, guard.session, req, { action: "fayda.start", targetType: who.table === "merchants" ? "merchant" : "staff", targetId: who.id, merchantId: id, details: { who: who.kind } });
    const res = NextResponse.json({ url });
    res.cookies.set(FAYDA_COOKIE, signState({ state, nonce, verifier, mid: id, kind: who.kind, id: who.id, exp: Math.floor(Date.now() / 1000) + FAYDA_TTL_S }, secret), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax", // the provider sends the person back with a normal link, which must carry this cookie
      path: "/api/fayda",
      maxAge: FAYDA_TTL_S,
    });
    return res;
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    console.error("[fayda start]", (e as Error).message);
    return bad("The national ID service is not reachable right now. Please try again.", 502);
  }
}