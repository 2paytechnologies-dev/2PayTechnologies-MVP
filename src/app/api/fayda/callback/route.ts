import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { currentSession } from "@/lib/guard";
import { authEnforced, sessionSecret } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { sealField } from "@/lib/fieldcrypt";
import { FAYDA_COOKIE, discover, exchangeCode, faydaConfig, readState, subjectHash, verifiedClaims } from "@/lib/fayda";
import { siteOrigin } from "@/lib/team-invite";

export const dynamic = "force-dynamic";

/**
 * Where the national ID provider sends the person back. The signed cookie from /fayda/start must be present and match the
 * `state` in the address (so a link someone else crafted does nothing); the code is traded for tokens using our signed
 * assertion; the ID token and the userinfo are verified against the provider's published keys; only then is the check recorded.
 * Every failure ends the same way for the person: back on the profile with a generic message (the detail goes to the server log).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (result: "ok" | "error" | "cancelled") => {
    const res = NextResponse.redirect(new URL(`/dashboard/merchant?tab=profile&fayda=${result}`, siteOrigin(req)));
    res.cookies.set(FAYDA_COOKIE, "", { path: "/api/fayda", maxAge: 0 });
    return res;
  };

  const secret = sessionSecret() ?? undefined;
  const cfg = faydaConfig();
  const st = readState((await cookies()).get(FAYDA_COOKIE)?.value, secret);
  if (url.searchParams.get("error")) return back("cancelled");
  const code = url.searchParams.get("code") ?? "";
  if (!cfg || !secret || !st || !code || url.searchParams.get("state") !== st.state) return back("error");

  try {
    // When sign-in is enforced, the person coming back must be the one who started.
    const session = await currentSession();
    if (authEnforced() && (!session || session.mid !== st.mid)) return back("error");

    const disc = await discover(cfg);
    const tokens = await exchangeCode(cfg, disc, code, st.verifier);
    const claims = await verifiedClaims(cfg, disc, tokens, st.nonce);

    const admin = getAdminClient();
    const table = st.kind === "OWNER" ? "merchants" : "merchant_staff";
    const filter = st.kind === "OWNER" ? { id: st.mid } : { id: st.id, merchant_id: st.mid };
    const { error } = await admin
      .from(table)
      .update({ fayda_verified_at: new Date().toISOString(), fayda_subject_hash: subjectHash(claims.sub, secret as string), fayda_name: claims.name ? sealField(claims.name, "national-id") : null })
      .match(filter);
    if (error) throw new Error(error.message);
    await audit(admin, session, req, { action: "fayda.verified", targetType: st.kind === "OWNER" ? "merchant" : "staff", targetId: st.id, merchantId: st.mid, details: { who: st.kind } });
    return back("ok");
  } catch (e) {
    if (e instanceof AdminConfigError) return back("error");
    console.error("[fayda callback]", (e as Error).message);
    return back("error");
  }
}