import { NextResponse } from "next/server";
import { feeBreakdown } from "@/lib/fee";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { isUuid, toMasked, type SavedAccount } from "@/lib/settlement";
import { requireMerchant } from "@/lib/guard";
import { nodeFeeContext } from "@/lib/watchdog";

export const dynamic = "force-dynamic";

/** Postgres 42703 (undefined column) / PostgREST PGRST204 (column missing from schema cache): a migration has not been applied. */
const isSchemaDrift = (e: { code?: string; message?: string }) => e.code === "42703" || e.code === "PGRST204" || /schema cache/i.test(e.message ?? "");
const SCHEMA_DRIFT = {
  error: "The database is out of date. Run the latest migrations in supabase/ in the Supabase SQL editor, then try again.",
  code: "SCHEMA_OUT_OF_DATE",
};

const MAX_PAGE = 1000;

/**
 * A merchant's transactions in [from, to), newest first, paged with limit/offset.
 * Used by the lookback, daily briefing and CSV export. Only the merchant (or an admin) may read them.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const merchantId = q.get("merchant_id") ?? "";
  if (!isUuid(merchantId)) return NextResponse.json({ error: "merchant_id (uuid) is required" }, { status: 400 });
  const guard = await requireMerchant(merchantId);
  if (!guard.ok) return guard.res;

  const from = q.get("from");
  const to = q.get("to");
  if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    return NextResponse.json({ error: "from and to (ISO timestamps) are required" }, { status: 400 });
  }
  const limit = Math.min(MAX_PAGE, Math.max(1, Number(q.get("limit")) || MAX_PAGE));
  const offset = Math.max(0, Number(q.get("offset")) || 0);

  try {
    const { data, error } = await getAdminClient()
      .from("transactions")
      .select("*")
      .eq("merchant_id", merchantId)
      .gte("created_at", from)
      .lt("created_at", to)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false }) // stable tiebreak so pages never overlap
      .range(offset, offset + limit); // one extra row tells the caller whether more remain
    if (error) {
      console.error("[transactions GET]", error.code, error.message);
      return NextResponse.json({ error: "Could not load transactions" }, { status: 500 });
    }
    const rows = data ?? [];
    // Rail credentials never leave the server: strip provider internals before returning.
    const safe = rows.slice(0, limit).map(({ rail_checkout_url, rail_session_id, rail_nonce, ...rest }) => rest);
    return NextResponse.json({ rows: safe, hasMore: rows.length > limit }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}

/**
 * Create a PENDING transaction (dynamic pay node) with a 90s TTL and a node-priced orchestration fee.
 * The merchant's active bank/wallet are snapshotted (masked) onto the row here, server-side, so the payer
 * can only ever settle through institutions the merchant has enabled.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const amount = Number(body?.amount);
  const merchantId = body?.merchant_id;

  if (!isUuid(merchantId) || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
    return NextResponse.json({ error: "Invalid merchant or amount" }, { status: 400 });
  }
  const guard = await requireMerchant(merchantId);
  if (!guard.ok) return guard.res;
  const rounded = Math.round(amount * 100) / 100;

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }

  const { data: merchant, error: mErr } = await admin.from("merchants").select("id, active_bank, active_wallet").eq("id", merchantId).maybeSingle();
  if (mErr) {
    console.error("[transactions] merchant lookup:", mErr.code, mErr.message);
    if (isSchemaDrift(mErr)) return NextResponse.json(SCHEMA_DRIFT, { status: 500 });
    return NextResponse.json({ error: "Could not load merchant" }, { status: 500 });
  }
  if (!merchant) return NextResponse.json({ error: "Unknown merchant" }, { status: 404 });

  const bank = merchant.active_bank as SavedAccount | null;
  const wallet = merchant.active_wallet as SavedAccount | null;
  if (!bank && !wallet) {
    return NextResponse.json(
      { error: "No settlement account configured. Add and activate a bank or wallet in Settings first.", code: "NO_ACTIVE_ROUTING" },
      { status: 409 },
    );
  }

  // F_t needs the node's risk/traffic/loyalty; a lookup failure prices the node neutrally.
  const ctx = await nodeFeeContext(admin, merchantId);
  const { fee } = feeBreakdown({ volume: rounded, ...ctx });

  const { data, error } = await admin
    .from("transactions")
    .insert({
      merchant_id: merchantId,
      amount: rounded,
      expected_amount: rounded,
      fee_ft: fee,
      expires_at: new Date(Date.now() + 90_000).toISOString(),
      routed_bank: bank ? toMasked(bank) : null,
      routed_wallet: wallet ? toMasked(wallet) : null,
    })
    .select()
    .single();

  if (error) {
    console.error("[transactions] insert:", error.code, error.message);
    if (isSchemaDrift(error)) return NextResponse.json(SCHEMA_DRIFT, { status: 500 });
    return NextResponse.json({ error: "Could not create pay node" }, { status: 500 });
  }
  return NextResponse.json(data, { status: 201 });
}
