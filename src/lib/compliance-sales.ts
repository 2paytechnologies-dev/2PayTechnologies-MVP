/**
 * How a paid sale is presented as evidence: the route it took, whether the payment provider's signed callback confirmed it, and what it
 * was charged. Shared by the compliance tab, the live sales table and the CSV export, so all three say the same thing.
 */
export type PathKind = "PROVIDER_CONFIRMED" | "SIMULATED" | "AWAITING_CALLBACK";

export interface SaleEvidence {
  id: string;
  time: string;
  business: string;
  terminal: string;
  source: string;
  amount: number;
  status: string;
  payer_app: string | null;
  provider: string | null;
  to_institution: string | null;
  /** Masked when the sale was made; the full number never reaches an admin screen or an export. */
  to_account: string | null;
  path: PathKind;
  confirmed_at: string | null;
  seconds_to_settle: number | null;
  amount_matches: boolean | null;
  base_fee: number | null;
  vat_fee: number | null;
  net_to_merchant: number | null;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => (v == null ? null : Number(v));

/** One row from admin_find_sales -> the evidence shown to an admin or an auditor. */
export function shapeSale(r: Row): SaleEvidence {
  const provider = (r.rail_provider as string | null) ?? null;
  const confirmed = r.confirmed === true;
  const method = r.settlement_method as string | null;
  const to = (method === "BANK" ? r.routed_bank : method === "WALLET" ? r.routed_wallet : (r.routed_wallet ?? r.routed_bank)) as { institution?: string; account_masked?: string } | null;
  const settled = r.settled_at ? new Date(r.settled_at as string).getTime() : null;
  const started = r.processing_at ? new Date(r.processing_at as string).getTime() : null;
  return {
    id: r.id as string,
    time: r.created_at as string,
    business: (r.business as string) ?? "",
    terminal: (r.terminal as string) ?? "",
    source: (r.source as string) ?? "TERMINAL",
    amount: Number(r.amount),
    status: r.status as string,
    payer_app: (r.payer_app as string | null) ?? null,
    provider,
    to_institution: to?.institution ?? (r.rail as string | null) ?? null,
    to_account: to?.account_masked ?? null,
    path: confirmed ? "PROVIDER_CONFIRMED" : provider ? "AWAITING_CALLBACK" : "SIMULATED",
    confirmed_at: confirmed ? ((r.confirmed_at as string | null) ?? (r.settled_at as string | null) ?? null) : null,
    seconds_to_settle: settled != null && started != null ? Math.max(0, Math.round((settled - started) / 1000)) : null,
    amount_matches: r.settled_amount == null ? null : Number(r.settled_amount) === Number(r.amount),
    base_fee: num(r.base_fee),
    vat_fee: num(r.vat_fee),
    net_to_merchant: num(r.net_merchant_settlement),
  };
}

// ------------------------------------------------------------------ CSV
export const CSV_HEADER = ["transaction_id", "time_utc", "business", "terminal", "channel", "amount_etb", "payer_app", "provider", "receiving_institution", "receiving_account_masked", "evidence", "confirmed_at_utc", "seconds_to_settle", "amount_matches_quote", "fee_before_vat", "vat", "merchant_net"];

/** A CSV cell. Quotes anything that needs it, and defuses spreadsheet formulas (a cell must never start with = + - @). */
export function csvCell(v: unknown): string {
  if (v == null) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function saleCsvRow(s: SaleEvidence): string {
  return [s.id, s.time, s.business, s.terminal, s.source, s.amount, s.payer_app, s.provider, s.to_institution, s.to_account, s.path, s.confirmed_at, s.seconds_to_settle, s.amount_matches, s.base_fee, s.vat_fee, s.net_to_merchant].map(csvCell).join(",");
}
