import { createHash, randomBytes } from "node:crypto";

/**
 * Team nodes and tips: the pure rules. Everything here is unit tested; the routes only wire it to the database.
 */

export type StaffRole = "CASHIER" | "WAITER" | "MANAGER";
export const STAFF_ROLES: readonly StaffRole[] = ["WAITER", "CASHIER", "MANAGER"];
/** "n" team members per business, with a ceiling so a runaway script cannot fill the table. */
export const MAX_TEAM = 200;

/** How long an activation link works. A person who misses it is sent a fresh one by the owner. */
export const INVITE_TTL_MS = 72 * 3600_000;

// ------------------------------------------------------------------ team numbers
const PREFIX: Record<StaffRole, string> = { WAITER: "W", CASHIER: "C", MANAGER: "M" };

/** W-001, W-014, C-002 ... Numbers are per business and role; they are never reused (removed members keep theirs). */
export const formatTeamNo = (role: StaffRole, n: number) => `${PREFIX[role]}-${String(Math.max(1, Math.floor(n))).padStart(3, "0")}`;

/** The next free number given the team numbers already used in this business (including removed members). */
export function nextTeamNo(role: StaffRole, used: readonly (string | null | undefined)[]): string {
  const re = new RegExp(`^${PREFIX[role]}-(\\d+)$`);
  let max = 0;
  for (const u of used) {
    const m = u ? re.exec(u) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return formatTeamNo(role, max + 1);
}

// ------------------------------------------------------------------ activation links
/** 256 random bits, URL-safe. Shown once to the owner (and sent by SMS); only its hash is stored. */
export const newInviteToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const looksLikeInviteToken = (t: unknown): t is string => typeof t === "string" && /^[A-Za-z0-9_-]{43}$/.test(t);

export const inviteExpiry = (now = Date.now()) => new Date(now + INVITE_TTL_MS).toISOString();
export const inviteIsLive = (expiresAt: string | null | undefined, now = Date.now()) => !!expiresAt && new Date(expiresAt).getTime() > now;

/** Fingerprint of the phone a team member activated on. The raw random id stays on that phone. */
export const hashDevice = (deviceId: string) => createHash("sha256").update(`2pay:device:${deviceId}`).digest("hex");
export const looksLikeDeviceId = (d: unknown): d is string => typeof d === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(d);

export type MemberStatus = "INVITED" | "ACTIVE" | "EXPIRED";
export function memberStatus(m: { activated_at: string | null; invite_expires_at: string | null }, now = Date.now()): MemberStatus {
  if (m.activated_at) return "ACTIVE";
  return inviteIsLive(m.invite_expires_at, now) ? "INVITED" : "EXPIRED";
}

// ------------------------------------------------------------------ tips
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Largest tip we accept in one payment: the bill again, but never more than 50,000 ETB. */
export const maxTip = (bill: number) => Math.min(round2(bill), 50_000);

/** Validate a tip chosen by the payer. Returns null when it is not a sane amount. */
export function cleanTip(raw: unknown, bill: number): number | null {
  if (raw === undefined || raw === null || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  const tip = round2(n);
  return tip > maxTip(bill) ? null : tip;
}

/**
 * Split what the rail collected into revenue and tip. The bill (what the waiter keyed) is revenue; anything the
 * customer paid above it is the tip, whether they chose it on the pay page or paid more at the provider.
 * Paying LESS than the bill is not a tip: it is returned as a shortfall for the caller to flag.
 */
export function splitPayment(bill: number, expected: number, settled: number | null | undefined): { revenue: number; tip: number; shortfall: number } {
  const revenue = round2(bill);
  if (settled == null) return { revenue, tip: round2(Math.max(0, expected - bill)), shortfall: 0 };
  const paid = round2(settled);
  if (paid + 0.005 < revenue) return { revenue, tip: 0, shortfall: round2(revenue - paid) };
  return { revenue, tip: round2(paid - revenue), shortfall: paid + 0.005 < expected ? round2(expected - paid) : 0 };
}

// ------------------------------------------------------------------ the confirmation both screens receive
/**
 * One paid sale as the waiter's phone and the cashier's master terminal both see it. Defined once so the two
 * screens can never disagree; today it is delivered by polling the server, and it is the payload a push channel
 * would carry (see docs/TEAM_NODE_TIPS.md).
 */
export interface ConfirmationEvent {
  type: "payment.confirmed";
  id: string;
  merchant_id: string;
  /** Who keyed the sale. null = the owner or the counter. */
  staff: { id: string; name: string; team_no: string | null; role: StaffRole } | null;
  currency: string;
  /** What the waiter keyed (revenue). */
  receipt_amount: number;
  /** The extra the customer paid on top. */
  tip: number;
  /** What the customer paid: receipt_amount + tip. */
  total_paid: number;
  rail: string;
  settlement_method: "BANK" | "WALLET" | null;
  status: string;
  at: string;
}

interface SaleRow {
  id: string;
  merchant_id: string;
  staff_id?: string | null;
  amount: number | string;
  tip_amount?: number | string | null;
  currency: string;
  rail: string;
  settlement_method?: "BANK" | "WALLET" | null;
  status: string;
  settled_at?: string | null;
  created_at: string;
}
export type StaffLookup = Record<string, { id: string; name: string; team_no: string | null; role: StaffRole }>;

export function toConfirmation(row: SaleRow, staff: StaffLookup): ConfirmationEvent {
  const receipt = round2(Number(row.amount));
  const tip = round2(Number(row.tip_amount ?? 0));
  return {
    type: "payment.confirmed",
    id: row.id,
    merchant_id: row.merchant_id,
    staff: row.staff_id ? (staff[row.staff_id] ?? { id: row.staff_id, name: "—", team_no: null, role: "WAITER" }) : null,
    currency: row.currency,
    receipt_amount: receipt,
    tip,
    total_paid: round2(receipt + tip),
    rail: row.rail,
    settlement_method: row.settlement_method ?? null,
    status: row.status,
    at: row.settled_at ?? row.created_at,
  };
}

// ------------------------------------------------------------------ daily ledger
export interface LedgerLine {
  staff_id: string | null;
  name: string;
  team_no: string | null;
  role: StaffRole | "OWNER";
  sales: number;
  revenue: number;
  tips: number;
  total: number;
}

/** Group paid sales by who took them. The owner's / counter's own sales (no staff id) are one line. */
export function buildLedger(rows: SaleRow[], staff: StaffLookup, counterName = "Counter"): LedgerLine[] {
  const by = new Map<string, LedgerLine>();
  for (const r of rows) {
    if (r.status !== "SUCCESS" && r.status !== "SETTLED") continue;
    const key = r.staff_id ?? "_counter";
    let line = by.get(key);
    if (!line) {
      const s = r.staff_id ? staff[r.staff_id] : undefined;
      line = { staff_id: r.staff_id ?? null, name: s?.name ?? (r.staff_id ? "—" : counterName), team_no: s?.team_no ?? null, role: s?.role ?? (r.staff_id ? "WAITER" : "OWNER"), sales: 0, revenue: 0, tips: 0, total: 0 };
      by.set(key, line);
    }
    const amount = Number(r.amount);
    const tip = Number(r.tip_amount ?? 0);
    line.sales += 1;
    line.revenue = round2(line.revenue + amount);
    line.tips = round2(line.tips + tip);
    line.total = round2(line.revenue + line.tips);
  }
  return [...by.values()].sort((a, b) => b.total - a.total);
}
