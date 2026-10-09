import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { referenceFor } from "@/lib/format";
import { AD_IMPRESSION_COST, type ReceiptView, type ServedAd } from "@/lib/types";

export const dynamic = "force-dynamic";

const AD_FIELDS = "id, title, description, image_url, phone_cta, location_cta";

/**
 * Receipt data for a completed payment, plus the sponsored offer to show.
 * The unguessable single-use token is the access credential. The ad stays
 * stable across reloads: if this transaction already has an impression, that
 * campaign is returned again, otherwise one eligible campaign is picked at random.
 */
export async function GET(_: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(token)) return NextResponse.json({ error: "Malformed token" }, { status: 400 });

  try {
    const admin = getAdminClient();
    const { data: tx, error } = await admin
      .from("transactions")
      .select("id, amount, currency, status, rail, created_at, viewed_at, latency_ms, settled_at, merchants(business_name, category, terminal_id, location)")
      .eq("token", token)
      .maybeSingle();
    if (error) {
      console.error("[receipt]", error.message);
      return NextResponse.json({ error: "Could not load receipt" }, { status: 500 });
    }
    if (!tx) return NextResponse.json({ error: "Receipt not found" }, { status: 404 });
    if (tx.status !== "SUCCESS" && tx.status !== "SETTLED") {
      return NextResponse.json({ error: "Payment not completed", status: tx.status }, { status: 409 });
    }

    const merchant = (Array.isArray(tx.merchants) ? tx.merchants[0] : tx.merchants) as {
      business_name: string;
      category: string;
      terminal_id: string;
      location: string | null;
    };

    let ad: ServedAd | null = null;
    try {
      const { data: prior } = await admin.from("ad_impressions").select("campaign_id").eq("transaction_id", tx.id).limit(1).maybeSingle();
      if (prior) {
        const { data } = await admin.from("ad_campaigns").select(AD_FIELDS).eq("id", prior.campaign_id).maybeSingle();
        ad = data as ServedAd | null;
      } else {
        const { data } = await admin
          .from("ad_campaigns")
          .select(AD_FIELDS)
          .eq("status", "ACTIVE")
          .gte("remaining_budget", AD_IMPRESSION_COST)
          .in("target_category", ["ALL", merchant.category])
          .limit(50);
        if (data?.length) ad = data[Math.floor(Math.random() * data.length)] as ServedAd;
      }
    } catch (e) {
      console.error("[receipt] ad lookup failed:", e); // a missing ad must never break the receipt
    }

    // Authorization instant = page-open time + server-measured latency (see authorize_transaction()).
    const authorizedAt =
      tx.viewed_at && tx.latency_ms != null ? new Date(new Date(tx.viewed_at).getTime() + tx.latency_ms).toISOString() : null;
    const paidAt = tx.settled_at ?? authorizedAt ?? tx.created_at;

    const view: ReceiptView = {
      reference: referenceFor(tx.id),
      amount: Number(tx.amount),
      currency: tx.currency,
      status: tx.status,
      rail: tx.rail,
      merchant_name: merchant.business_name,
      terminal_id: merchant.terminal_id,
      location: merchant.location,
      paid_at: paidAt,
      transaction_id: tx.id,
      ad,
    };
    return NextResponse.json(view);
  } catch (e) {
    if (e instanceof AdminConfigError) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    throw e;
  }
}
