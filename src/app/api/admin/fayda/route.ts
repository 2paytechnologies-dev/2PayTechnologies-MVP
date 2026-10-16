import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireAdmin } from "@/lib/guard";
import { EKYC_MAX_ATTEMPTS, ekycMode, faydaRequired } from "@/lib/fayda-ekyc";
import { faydaConfigured } from "@/lib/fayda";

export const dynamic = "force-dynamic";

export type FaydaState = "VERIFIED" | "IN_PROGRESS" | "LOCKED" | "NOT_STARTED";
const PAGE_SIZE = 25;
const FILTERS = ["ALL", "VERIFIED", "PENDING", "IN_PROGRESS", "LOCKED"] as const;

/**
 * The Fayda (national ID) verification status of business owners, built for any number of merchants: the counts are computed by the
 * database, the list is one page of 25 at a time, and you find a merchant by searching (terminal id, phone, or part of the name). Never the FAN,
 * the name or any ID detail: admins see only who is verified, when, and the gateway reference they could quote to the National ID Program.
 * GET ?state=ALL|VERIFIED|PENDING|IN_PROGRESS|LOCKED&q=...&page=1
 */
export async function GET(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.res;
  const sp = new URL(req.url).searchParams;
  const filter = (FILTERS as readonly string[]).includes(sp.get("state") ?? "") ? (sp.get("state") as (typeof FILTERS)[number]) : "ALL";
  const q = (sp.get("q") ?? "").trim().slice(0, 60);
  const page = Math.max(1, Math.min(10_000, Math.floor(Number(sp.get("page"))) || 1));

  try {
    const admin = getAdminClient();
    const now = new Date().toISOString();
    const head = { count: "exact" as const, head: true };
    const [total, verified, open] = await Promise.all([
      admin.from("merchants").select("id", head).neq("kind", "RIDE_PARTNER").neq("kind", "DRIVER"),
      admin.from("merchants").select("id", head).neq("kind", "RIDE_PARTNER").neq("kind", "DRIVER").eq("fayda_verified", true),
      admin.from("fayda_sessions").select("merchant_id, attempts").is("consumed_at", null).gte("expires_at", now).limit(5000),
    ]);
    if (total.error) return NextResponse.json({ error: "Could not load the Fayda status. Has supabase/v2_5.sql been run?" }, { status: 500 });

    // Requests in progress right now, by merchant (the highest attempt count wins when someone asked twice).
    const live = new Map<string, number>();
    for (const r of open.error ? [] : (open.data ?? [])) live.set(r.merchant_id as string, Math.max(live.get(r.merchant_id as string) ?? 0, Number(r.attempts)));
    const locked = [...live.values()].filter((a) => a >= EKYC_MAX_ATTEMPTS).length;
    const inProgress = live.size - locked;
    const summary = { total: total.count ?? 0, verified: verified.count ?? 0, in_progress: inProgress, locked, not_started: Math.max(0, (total.count ?? 0) - (verified.count ?? 0) - live.size) };

    let query = admin
      .from("merchants")
      .select("id, business_name, terminal_id, phone, kyc_status, fayda_verified, fayda_verified_at, fayda_verification_timestamp, fayda_transaction_id", { count: "exact" })
      .neq("kind", "RIDE_PARTNER").neq("kind", "DRIVER")
      .order("business_name");
    if (filter === "VERIFIED") query = query.eq("fayda_verified", true);
    if (filter === "PENDING") query = query.eq("fayda_verified", false);
    if (filter === "IN_PROGRESS" || filter === "LOCKED") {
      const ids = [...live.entries()].filter(([, a]) => (filter === "LOCKED" ? a >= EKYC_MAX_ATTEMPTS : a < EKYC_MAX_ATTEMPTS)).map(([id]) => id);
      if (!ids.length) return NextResponse.json(reply(summary, [], 0, page, filter, q), { headers: { "Cache-Control": "private, no-store" } });
      query = query.in("id", ids.slice(0, 200));
    }
    if (q) {
      if (/^[+\d]/.test(q)) query = query.like("phone", `${q.replace(/[^+\d]/g, "")}%`);
      else if (/^[A-Za-z]{2,5}-\w+$/.test(q) && /\d/.test(q)) query = query.ilike("terminal_id", `${q}%`);
      else query = query.ilike("business_name", `%${q.replace(/[%_]/g, "")}%`);
    }
    const from = (page - 1) * PAGE_SIZE;
    const { data, error, count } = await query.range(from, from + PAGE_SIZE - 1);
    if (error) return NextResponse.json({ error: "Could not load the list" }, { status: 500 });

    const rows = (data ?? []).map((r) => {
      const isVerified = !!(r.fayda_verified || r.fayda_verified_at);
      const attempts = live.get(r.id as string);
      const state: FaydaState = isVerified ? "VERIFIED" : attempts == null ? "NOT_STARTED" : attempts >= EKYC_MAX_ATTEMPTS ? "LOCKED" : "IN_PROGRESS";
      return {
        id: r.id,
        business: r.business_name,
        terminal: r.terminal_id,
        phone: r.phone,
        kyc_status: r.kyc_status,
        state,
        verified_at: isVerified ? (r.fayda_verification_timestamp ?? r.fayda_verified_at ?? null) : null,
        gateway_ref: isVerified ? (r.fayda_transaction_id ?? null) : null,
        wrong_codes: attempts ?? 0,
      };
    });
    return NextResponse.json(reply(summary, rows, count ?? rows.length, page, filter, q), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }

  function reply(summary: object, rows: object[], matching: number, pg: number, st: string, search: string) {
    return {
      summary,
      // what is switched on right now, so the tracker can say why nobody can verify yet
      setup: { required: faydaRequired(), ekyc: ekycMode() ?? "off", browser_signin: faydaConfigured() },
      rows,
      paging: { page: pg, page_size: PAGE_SIZE, matching, pages: Math.max(1, Math.ceil(matching / PAGE_SIZE)), state: st, q: search },
    };
  }
}
