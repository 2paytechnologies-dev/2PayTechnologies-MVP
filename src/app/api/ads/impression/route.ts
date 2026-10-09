import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { AD_IMPRESSION_COST } from "@/lib/types";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Log one impression and bill the campaign 0.05 ETB. All of it runs inside the
 * record_ad_impression() SQL function: row-locked, idempotent per (campaign, transaction),
 * and flips the campaign to EXHAUSTED when remaining_budget drops below 0.05.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const campaignId = body?.campaign_id;
  const transactionId = body?.transaction_id;
  if (typeof campaignId !== "string" || typeof transactionId !== "string" || !UUID.test(campaignId) || !UUID.test(transactionId)) {
    return NextResponse.json({ error: "campaign_id and transaction_id (uuid) are required" }, { status: 400 });
  }

  try {
    const { data, error } = await getAdminClient().rpc("record_ad_impression", {
      p_campaign_id: campaignId,
      p_transaction_id: transactionId,
      p_cost: AD_IMPRESSION_COST,
    });
    if (error) {
      if (error.message.includes("TRANSACTION_NOT_ELIGIBLE"))
        return NextResponse.json({ error: "Transaction is not a completed payment" }, { status: 409 });
      if (error.message.includes("CAMPAIGN_NOT_FOUND")) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
      console.error("[ads/impression]", error.message);
      return NextResponse.json({ error: "Could not record impression" }, { status: 500 });
    }
    return NextResponse.json(data);
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
