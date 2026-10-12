import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireMerchant } from "@/lib/guard";
import { isUuid } from "@/lib/settlement";
import { audit } from "@/lib/audit";
import { referenceFor } from "@/lib/format";

export const dynamic = "force-dynamic";

const bad = (error: string, status = 400) => NextResponse.json({ error, ...(status === 409 ? { code: "CONFLICT" } : {}) }, { status });

/** A merchant's refund requests, newest first. */
export async function GET(req: Request) {
  const merchantId = new URL(req.url).searchParams.get("merchant_id") ?? "";
  if (!isUuid(merchantId)) return bad("merchant_id (uuid) is required");
  const guard = await requireMerchant(merchantId, { owner: true });
  if (!guard.ok) return guard.res;
  try {
    const { data, error } = await getAdminClient()
      .from("refund_requests")
      .select("id, transaction_id, amount, reason, status, admin_note, created_at, updated_at")
      .eq("merchant_id", merchantId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) return bad("Could not load refund requests", 500);
    return NextResponse.json((data ?? []).map((r) => ({ ...r, reference: referenceFor(r.transaction_id) })), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}

/**
 * Ask for a refund on a paid sale. 2Pay records the request, the decision and the audit trail; moving the money
 * back is done with the provider (an operator marks the request REFUNDED once it is).
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const merchantId = body?.merchant_id;
  const transactionId = body?.transaction_id;
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!isUuid(merchantId) || !isUuid(transactionId)) return bad("merchant_id and transaction_id (uuid) are required");
  if (reason.length < 3 || reason.length > 300) return bad("Please give a reason (3–300 characters)");
  const guard = await requireMerchant(merchantId, { owner: true });
  if (!guard.ok) return guard.res;

  try {
    const admin = getAdminClient();
    const { data: tx } = await admin.from("transactions").select("id, merchant_id, amount, status").eq("id", transactionId).maybeSingle();
    if (!tx || tx.merchant_id !== merchantId) return bad("Sale not found", 404);
    if (tx.status !== "SUCCESS" && tx.status !== "SETTLED") return bad("Only a paid sale can be refunded");

    const amount = Math.round(Number(body?.amount ?? tx.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0 || amount > Number(tx.amount)) return bad(`The refund must be between 0.01 and ${Number(tx.amount).toFixed(2)} ETB`);

    const { data, error } = await admin
      .from("refund_requests")
      .insert({ transaction_id: tx.id, merchant_id: merchantId, amount, reason, requested_by: guard.session?.ph ?? null })
      .select("id, status, amount, created_at")
      .single();
    if (error) {
      if (error.code === "23505") return bad("A refund request is already open for this sale", 409);
      console.error("[refunds POST]", error.message);
      return bad("Could not create the refund request", 500);
    }
    await audit(admin, guard.session, req, { action: "refund.request", targetType: "refund", targetId: data.id, merchantId, details: { transaction_id: tx.id, amount, reason } });
    return NextResponse.json(data, { status: 201 });
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}
