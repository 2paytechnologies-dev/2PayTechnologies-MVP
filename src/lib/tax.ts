import type { Category } from "@/lib/categories";

/**
 * Digital tax estimation. An ESTIMATE of tax on what a business took through 2Pay, never a tax return: cash and other channels are not seen,
 * input-VAT credits and allowable expenses are not known, and Ethiopian rates and thresholds have been changing (a new 2025 proclamation), so
 * every number here comes from RULES that an administrator sets and confirms, not from constants in the code. The defaults below are the
 * long-standing rates, shipped UNCONFIRMED: the screen says so until an administrator marks the rules confirmed against current law.
 */
export interface TaxRules {
  vat: {
    /** Output VAT rate, e.g. 0.15. */
    rate: number;
    /** Annual turnover (ETB) from which a business is VAT-registered; below it the turnover tax applies. */
    threshold: number;
    /** True when the prices customers pay already include VAT (the usual retail case), so VAT is the share inside the price. */
    inclusive: boolean;
  };
  turnover: {
    /** Turnover tax rate when no category rate applies. */
    rate: number;
    /** Turnover tax rate per merchant category (goods and services are taxed differently). */
    byCategory: Partial<Record<Category, number>>;
  };
}

export const DEFAULT_TAX_RULES: TaxRules = {
  vat: { rate: 0.15, threshold: 1_000_000, inclusive: true },
  turnover: { rate: 0.02, byCategory: { Fuel: 0.02, Retail: 0.02, Supermarket: 0.02, Merchant: 0.02, Service: 0.1, Ride: 0.1 } },
};

const rate = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback);
const money = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e12 ? v : fallback);

/** Stored rules (possibly partial, possibly junk) laid over the defaults. Never throws; anything invalid falls back to the default. */
export function resolveRules(stored: unknown): TaxRules {
  const s = (stored && typeof stored === "object" ? stored : {}) as Record<string, Record<string, unknown> | undefined>;
  const d = DEFAULT_TAX_RULES;
  const byCategory: TaxRules["turnover"]["byCategory"] = { ...d.turnover.byCategory };
  const stc = s.turnover?.byCategory;
  if (stc && typeof stc === "object") for (const k of Object.keys(byCategory) as Category[]) byCategory[k] = rate((stc as Record<string, unknown>)[k], byCategory[k] ?? d.turnover.rate);
  return {
    vat: { rate: rate(s.vat?.rate, d.vat.rate), threshold: money(s.vat?.threshold, d.vat.threshold), inclusive: typeof s.vat?.inclusive === "boolean" ? s.vat.inclusive : d.vat.inclusive },
    turnover: { rate: rate(s.turnover?.rate, d.turnover.rate), byCategory },
  };
}

/** Check rules an administrator submits. Unlike `resolveRules` this refuses bad input instead of quietly correcting it. */
export function validateRules(input: unknown): { ok: true; rules: TaxRules } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Rules must be an object" };
  const i = input as Record<string, Record<string, unknown> | undefined>;
  const isRate = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  if (!isRate(i.vat?.rate)) return { ok: false, error: "VAT rate must be between 0 and 1 (0.15 means 15%)" };
  if (typeof i.vat?.threshold !== "number" || !Number.isFinite(i.vat.threshold) || i.vat.threshold < 0 || i.vat.threshold > 1e12) return { ok: false, error: "VAT threshold must be an amount in birr, 0 or more" };
  if (typeof i.vat?.inclusive !== "boolean") return { ok: false, error: "Say whether prices include VAT" };
  if (!isRate(i.turnover?.rate)) return { ok: false, error: "Turnover tax rate must be between 0 and 1" };
  const by = i.turnover?.byCategory as Record<string, unknown> | undefined;
  if (by !== undefined) {
    if (!by || typeof by !== "object") return { ok: false, error: "Category rates must be an object" };
    for (const [k, v] of Object.entries(by)) if (!(k in DEFAULT_TAX_RULES.turnover.byCategory) || !isRate(v)) return { ok: false, error: `Bad turnover rate for ${k}` };
  }
  return { ok: true, rules: resolveRules(input) };
}

export interface MonthVolume {
  month: string; // YYYY-MM, Addis Ababa
  sales: number;
  gross: number;
  tips: number;
  refunded: number;
}

export interface MonthTax {
  month: string;
  sales: number;
  /** Tips are never the business's turnover (they belong to staff), so they are not counted. */
  turnover: number;
  tax: number;
}

export interface TaxEstimate {
  year: number;
  regime: "VAT" | "TURNOVER";
  /** Which rate was used, as a fraction (the VAT rate, or the category's turnover tax rate). */
  rate: number;
  months: MonthTax[];
  ytd: { turnover: number; tax: number };
  /** The year so far, scaled to twelve months (the year itself, once it is over). Decides the regime and gives a planning figure. */
  projected: { turnover: number; tax: number };
  monthsCounted: number;
  vatThreshold: number;
  inclusive: boolean;
}

/** Calendar year and month in Addis Ababa. Ethiopia has no daylight saving, so this is UTC plus three hours. */
export function addisYearMonth(now: Date): { year: number; month: number } {
  const d = new Date(now.getTime() + 3 * 3600_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function taxOn(turnover: number, regime: "VAT" | "TURNOVER", rules: TaxRules, category: Category): number {
  if (turnover <= 0) return 0;
  if (regime === "VAT") return rules.vat.inclusive ? (turnover * rules.vat.rate) / (1 + rules.vat.rate) : turnover * rules.vat.rate;
  return turnover * (rules.turnover.byCategory[category] ?? rules.turnover.rate);
}

/**
 * Estimate the year's tax from per-month digital volume. Net turnover per month = settled sales minus refunds (never below zero, tips excluded).
 * The regime follows the PROJECTED annual turnover against the VAT threshold: at or above it VAT applies, below it the category's turnover tax.
 * `now` fixes which months of `year` are still to come (a month with no sales so far still counts as elapsed).
 */
export function estimateTax(volume: MonthVolume[], year: number, category: Category, rules: TaxRules, now: Date = new Date()): TaxEstimate {
  const { year: thisYear, month: thisMonth } = addisYearMonth(now);
  const monthsCounted = year < thisYear ? 12 : year > thisYear ? 0 : thisMonth;

  const net = volume
    .filter((v) => v.month.startsWith(`${year}-`))
    .map((v) => ({ month: v.month, sales: v.sales, turnover: Math.max(0, Number(v.gross) - Number(v.refunded)) }));
  const ytdTurnover = net.reduce((a, m) => a + m.turnover, 0);
  const projectedTurnover = monthsCounted > 0 ? (ytdTurnover / monthsCounted) * 12 : 0;

  const regime: TaxEstimate["regime"] = projectedTurnover >= rules.vat.threshold ? "VAT" : "TURNOVER";
  const months: MonthTax[] = net.map((m) => ({ month: m.month, sales: m.sales, turnover: r2(m.turnover), tax: r2(taxOn(m.turnover, regime, rules, category)) }));
  return {
    year,
    regime,
    rate: regime === "VAT" ? rules.vat.rate : (rules.turnover.byCategory[category] ?? rules.turnover.rate),
    months,
    ytd: { turnover: r2(ytdTurnover), tax: r2(taxOn(ytdTurnover, regime, rules, category)) },
    projected: { turnover: r2(projectedTurnover), tax: r2(taxOn(projectedTurnover, regime, rules, category)) },
    monthsCounted,
    vatThreshold: rules.vat.threshold,
    inclusive: rules.vat.inclusive,
  };
}

/** A business qualifies for the estimate once it has registered with a TIN and a business licence. */
export function taxEligibility(m: { tin: string | null | undefined; business_license: string | null | undefined }): { eligible: boolean; missing: ("tin" | "business_license")[] } {
  const missing: ("tin" | "business_license")[] = [];
  if (!m.tin) missing.push("tin");
  if (!m.business_license) missing.push("business_license");
  return { eligible: missing.length === 0, missing };
}
