import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { AD_IMPRESSION_COST, type TargetCategory } from "@/lib/types";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES: TargetCategory[] = ["ALL", "Fuel", "Retail"];
const MIN_BUDGET = 5;
const MAX_BUDGET = 100_000;

const configError = () => NextResponse.json({ error: "Server misconfigured" }, { status: 500 });

/** Campaigns owned by one merchant, newest first. */
export async function GET(req: Request) {
  const merchantId = new URL(req.url).searchParams.get("merchant_id") ?? "";
  if (!UUID.test(merchantId)) return NextResponse.json({ error: "merchant_id (uuid) is required" }, { status: 400 });
  try {
    const { data, error } = await getAdminClient()
      .from("ad_campaigns")
      .select("*")
      .eq("merchant_id", merchantId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) {
      console.error("[ads/campaigns GET]", error.message);
      return NextResponse.json({ error: "Could not load campaigns" }, { status: 500 });
    }
    return NextResponse.json(data);
  } catch (e) {
    if (e instanceof AdminConfigError) return configError();
    throw e;
  }
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 && s.length <= max ? s : null;
}

function httpUrl(v: unknown): string | null {
  const s = cleanText(v, 500);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Create a self-serve campaign. Budget is the full spend cap; each impression costs 0.05 ETB. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const merchantId = body.merchant_id;
  const title = cleanText(body.title, 80);
  const description = cleanText(body.description, 240);
  const category: TargetCategory = CATEGORIES.includes(body.target_category) ? body.target_category : "ALL";
  const budget = Math.round(Number(body.budget) * 100) / 100;

  const imageRaw = typeof body.image_url === "string" ? body.image_url.trim() : "";
  const imageUrl = imageRaw ? httpUrl(imageRaw) : null;
  const phoneRaw = typeof body.phone_cta === "string" ? body.phone_cta.replace(/[\s()-]/g, "") : "";
  const locationRaw = typeof body.location_cta === "string" ? body.location_cta.trim() : "";

  const errors: string[] = [];
  if (typeof merchantId !== "string" || !UUID.test(merchantId)) errors.push("merchant_id is required");
  if (!title) errors.push("Title is required (max 80 characters)");
  if (!description) errors.push("Description is required (max 240 characters)");
  if (imageRaw && !imageUrl) errors.push("Image URL must be a valid http(s) link");
  if (phoneRaw && !/^\+?\d{7,15}$/.test(phoneRaw)) errors.push("Phone must be 7–15 digits, optionally starting with +");
  if (locationRaw.length > 300) errors.push("Location is too long (max 300 characters)");
  if (!Number.isFinite(budget) || budget < MIN_BUDGET || budget > MAX_BUDGET)
    errors.push(`Budget must be between ${MIN_BUDGET} and ${MAX_BUDGET} ETB`);
  if (errors.length) return NextResponse.json({ error: errors.join(". ") }, { status: 400 });

  try {
    const admin = getAdminClient();
    const { data: merchant } = await admin.from("merchants").select("id").eq("id", merchantId).maybeSingle();
    if (!merchant) return NextResponse.json({ error: "Unknown merchant" }, { status: 404 });

    const { data, error } = await admin
      .from("ad_campaigns")
      .insert({
        merchant_id: merchantId,
        title,
        description,
        target_category: category,
        image_url: imageUrl,
        phone_cta: phoneRaw || null,
        location_cta: locationRaw || null,
        budget,
        remaining_budget: budget,
        status: budget >= AD_IMPRESSION_COST ? "ACTIVE" : "EXHAUSTED",
      })
      .select()
      .single();
    if (error) {
      console.error("[ads/campaigns POST]", error.message);
      return NextResponse.json({ error: "Could not create campaign" }, { status: 500 });
    }
    return NextResponse.json(data, { status: 201 });
  } catch (e) {
    if (e instanceof AdminConfigError) return configError();
    throw e;
  }
}
