import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Count a Call / View Location tap. At most one click is counted per impression. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const campaignId = body?.campaign_id;
  const transactionId = body?.transaction_id;
  if (typeof campaignId !== "string" || typeof transactionId !== "string" || !UUID.test(campaignId) || !UUID.test(transactionId)) {
    return NextResponse.json({ error: "campaign_id and transaction_id (uuid) are required" }, { status: 400 });
  }
  try {
    const { data, error } = await getAdminClient().rpc("record_ad_click", {
      p_campaign_id: campaignId,
      p_transaction_id: transactionId,
    });
    if (error) {
      console.error("[ads/click]", error.message);
      return NextResponse.json({ error: "Could not record click" }, { status: 500 });
    }
    return NextResponse.json(data);
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
