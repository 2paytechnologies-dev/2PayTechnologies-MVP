import { NextResponse } from "next/server";
import { AdminConfigError, getAdminClient } from "@/lib/supabase-admin";
import { requireMerchant } from "@/lib/guard";
import { isUuid } from "@/lib/settlement";
import { addisYearMonth, estimateTax, resolveRules, taxEligibility, type MonthVolume } from "@/lib/tax";
import type { Category } from "@/lib/categories";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status, headers: NO_STORE });

const DISCLAIMER = "This is an estimate from the payments that went through 2Pay only. It is not a tax return and not tax advice. Cash sales, other payment channels, expenses and input VAT are not included. Confirm your figures with the tax authority or an accountant.";

/**
 * Estimated tax on a business's digital takings (owner only). Available once the business has registered with a TIN and a business licence;
 * until then the answer says what is missing. `?year=` is the calendar year (Addis Ababa time), default the current one. The rules behind
 * the estimate are the administrator's, and the answer says whether they have been confirmed.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return bad("Malformed merchant id");
  const guard = await requireMerchant(id, { owner: true });
  if (!guard.ok) return guard.res;
  const now = new Date();
  const thisYear = addisYearMonth(now).year;
  const asked = Number(new URL(req.url).searchParams.get("year"));
  const year = Number.isInteger(asked) && asked >= 2024 && asked <= thisYear ? asked : thisYear;

  try {
    const admin = getAdminClient();
    const { data: m } = await admin.from("merchants").select("category, kind, tin, business_license, legal_name, kyc_status").eq("id", id).maybeSingle();
    if (!m) return bad("Merchant not found", 404);
    const el = taxEligibility({ tin: m.tin, business_license: m.business_license });
    if (!el.eligible) return NextResponse.json({ eligible: false, missing: el.missing, year }, { headers: NO_STORE });

    const from = new Date(Date.UTC(year, 0, 1) - 3 * 3600_000).toISOString(); // midnight 1 January in Addis Ababa (UTC+3)
    const to = new Date(Date.UTC(year + 1, 0, 1) - 3 * 3600_000).toISOString();
    const [vol, settings] = await Promise.all([admin.rpc("merchant_tax_volume", { p_merchant: id, p_from: from, p_to: to }), admin.from("tax_settings").select("rules, version, confirmed_by, confirmed_at").eq("id", 1).maybeSingle()]);
    if (vol.error) {
      console.error("[tax]", vol.error.message);
      return bad("Could not work out the estimate", 500);
    }
    const rules = resolveRules(settings.data?.rules);
    const estimate = estimateTax((vol.data ?? []) as MonthVolume[], year, (m.category ?? "Merchant") as Category, rules, now);
    return NextResponse.json(
      {
        eligible: true,
        legal_name: m.legal_name ?? null,
        verified: m.kyc_status === "VERIFIED",
        category: m.category,
        estimate,
        rules: { version: settings.data?.version ?? 1, confirmed: !!settings.data?.confirmed_at, confirmed_at: settings.data?.confirmed_at ?? null },
        disclaimer: DISCLAIMER,
      },
      { headers: NO_STORE },
    );
  } catch (e) {
    if (e instanceof AdminConfigError) return bad("Server misconfigured", 500);
    throw e;
  }
}
