import { BANKS, MAX_SAVED, WALLETS, type SettlementKind } from "./constants";

/** Pure validation/normalisation for settlement accounts. Used by the API route and the settings form. */

/** Stored on merchants (server-side only; contains the full account number). */
export interface SavedAccount {
  id: string;
  institution: string;
  account_number: string;
}

/** Safe to send to browsers and to store on transactions. */
export interface MaskedAccount {
  id: string;
  institution: string;
  account_masked: string;
}

export interface SettlementView {
  saved_banks: MaskedAccount[];
  saved_wallets: MaskedAccount[];
  active_bank_id: string | null;
  active_wallet_id: string | null;
}

/** One row of the settings form. Existing rows send only `id`; new rows send institution + number. */
export interface AccountEntry {
  id: string;
  institution?: string;
  account_number?: string;
}

export interface SettlementInput {
  banks: AccountEntry[];
  wallets: AccountEntry[];
  active_bank_id: string | null;
  active_wallet_id: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

export const maskAccount = (n: string) => `••••${n.slice(-4)}`;

export const toMasked = (a: SavedAccount): MaskedAccount => ({ id: a.id, institution: a.institution, account_masked: maskAccount(a.account_number) });

/** Bank account numbers: 6–20 digits (spaces and dashes tolerated). */
export function normalizeBankAccount(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[\s-]/g, "");
  return /^\d{6,20}$/.test(s) ? s : null;
}

/** Wallet numbers are Ethiopian mobile numbers; stored as +251XXXXXXXXX. */
export function normalizeWalletNumber(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[\s()-]/g, "");
  const m = /^(?:\+?251|0)([79]\d{8})$/.exec(s);
  return m ? `+251${m[1]}` : null;
}

export const normalizeAccount = (kind: SettlementKind, raw: unknown) => (kind === "bank" ? normalizeBankAccount(raw) : normalizeWalletNumber(raw));

export const institutionsFor = (kind: SettlementKind): readonly string[] => (kind === "bank" ? BANKS : WALLETS);

export type BuildResult = { ok: true; accounts: SavedAccount[] } | { ok: false; error: string };

/**
 * Turn the submitted rows into the list to store. Rows whose id already exists keep their stored
 * institution and number (the browser never sees full numbers). New rows are fully validated.
 */
export function buildAccounts(kind: SettlementKind, entries: unknown, stored: SavedAccount[]): BuildResult {
  const label = kind === "bank" ? "bank" : "wallet";
  if (!Array.isArray(entries)) return { ok: false, error: `${label}s must be a list` };
  if (entries.length > MAX_SAVED) return { ok: false, error: `You can save at most ${MAX_SAVED} ${label}s` };

  const byId = new Map(stored.map((a) => [a.id, a]));
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const out: SavedAccount[] = [];

  for (const e of entries as AccountEntry[]) {
    if (!e || !isUuid(e.id)) return { ok: false, error: `Invalid ${label} entry` };
    if (seenIds.has(e.id)) return { ok: false, error: `Duplicate ${label} entry` };
    seenIds.add(e.id);

    let acct: SavedAccount;
    const existing = byId.get(e.id);
    if (existing) {
      acct = existing;
    } else {
      if (typeof e.institution !== "string" || !institutionsFor(kind).includes(e.institution)) {
        return { ok: false, error: `Choose a valid ${label} from the list` };
      }
      const number = normalizeAccount(kind, e.account_number);
      if (!number) {
        return {
          ok: false,
          error: kind === "bank" ? `${e.institution}: account number must be 6–20 digits` : `${e.institution}: enter a valid Ethiopian mobile number (e.g. 0911223344)`,
        };
      }
      acct = { id: e.id, institution: e.institution, account_number: number };
    }

    const key = `${acct.institution}|${acct.account_number}`;
    if (seenKeys.has(key)) return { ok: false, error: `${acct.institution} ${maskAccount(acct.account_number)} is already saved` };
    seenKeys.add(key);
    out.push(acct);
  }
  return { ok: true, accounts: out };
}

/** Exactly one active account whenever any are saved; none when the list is empty. */
export function pickActive(kind: SettlementKind, accounts: SavedAccount[], activeId: unknown): { ok: true; active: SavedAccount | null } | { ok: false; error: string } {
  if (accounts.length === 0) return { ok: true, active: null };
  const match = accounts.find((a) => a.id === activeId);
  if (!match) return { ok: false, error: `Select exactly one active ${kind}` };
  return { ok: true, active: match };
}
