import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";
import { cookieShare } from "@/lib/deploy";

export const dynamic = "force-dynamic";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0, ...cookieShare() });
  return res;
}
