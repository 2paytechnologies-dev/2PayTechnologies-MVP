import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession, type SessionPayload } from "@/lib/session";
import { authEnforced, normalizePhone } from "@/lib/auth";

/**
 * Access control for route handlers.
 * TEST MODE (AUTH_ENFORCED unset): every check passes, so anyone with the link can use everything.
 * ENFORCED: a merchant may only touch their own merchant id, and admin routes need a phone listed in ADMIN_PHONES.
 * Roles: the OWNER (the merchant's own phone) can do everything for that merchant; a CASHIER can run the terminal
 * and see the last 24 hours of sales, and nothing else.
 */
export type Guard = { ok: true; session: SessionPayload | null } | { ok: false; res: NextResponse };

const deny = (status: 401 | 403, error: string): Guard => ({ ok: false, res: NextResponse.json({ error }, { status }) });

export async function currentSession(): Promise<SessionPayload | null> {
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value, process.env.SESSION_SECRET);
}

/** Phones allowed into the admin hub, from ADMIN_PHONES="0911223344,+251711223344". */
export const adminPhones = (): string[] =>
  (process.env.ADMIN_PHONES ?? "")
    .split(",")
    .map((p) => normalizePhone(p.trim()))
    .filter((p): p is string => !!p);

export const isAdminPhone = (phone: string | undefined): boolean => !!phone && adminPhones().includes(phone);

export const roleOf = (s: SessionPayload | null): "OWNER" | "CASHIER" => s?.rl ?? "OWNER";

export async function requireSession(): Promise<Guard> {
  if (!authEnforced()) return { ok: true, session: await currentSession() };
  const session = await currentSession();
  return session ? { ok: true, session } : deny(401, "Authentication required");
}

/**
 * The caller may act on `merchantId`: it is their own (or they are an admin).
 * Pass `{ owner: true }` for anything a cashier must not do (money routing, ads, staff, profile, refunds, exports).
 */
export async function requireMerchant(merchantId: string, opts: { owner?: boolean } = {}): Promise<Guard> {
  const g = await requireSession();
  if (!g.ok || !authEnforced()) return g;
  const s = g.session!;
  if (isAdminPhone(s.ph)) return g;
  if (s.mid !== merchantId) return deny(403, "You do not have access to this merchant");
  if (opts.owner && roleOf(s) !== "OWNER") return deny(403, "Only the business owner can do this");
  return g;
}

export async function requireAdmin(): Promise<Guard> {
  const g = await requireSession();
  if (!g.ok || !authEnforced()) return g;
  return isAdminPhone(g.session!.ph) ? g : deny(403, "Administrator access required");
}
