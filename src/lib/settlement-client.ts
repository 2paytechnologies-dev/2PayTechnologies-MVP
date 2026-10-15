import type { SettlementKind } from "@/lib/constants";
import type { AccountEntry, MaskedAccount, SettlementInput, SettlementView } from "@/lib/settlement";

/** Browser-side calls for the merchant's payment accounts. Every change is saved immediately (no big "Save" form). */
export async function loadSettlement(merchantId: string): Promise<SettlementView> {
  const res = await fetch(`/api/merchants/${merchantId}/settlement`, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "load");
  return data as SettlementView;
}

/** The server wants the approver's security key and phone code (or the key is not set up yet) before it changes where money goes. */
export class StepUpRequiredError extends Error {
  constructor() {
    super("step-up required");
  }
}

export interface VaultStatus {
  approver: "OWNER" | "MANAGER";
  has_phone: boolean;
  has_pin: boolean;
  phone_masked: string | null;
  locked_minutes: number;
}

async function call<T>(merchantId: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/merchants/${merchantId}/settlement/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(d.error ?? "request"), { code: d.code as string | undefined, minutes: d.minutes as number | undefined });
  return d as T;
}

export type Challenge = { challenge_id: string; phone_masked: string; dev_code?: string; /** the forgotten-key check also includes Fayda */ fayda_check?: boolean };

export const vaultStatus = (m: string) => call<VaultStatus>(m, "vault");
/** Step 1 of unlocking: the security key. Only a right key makes the server send the code. */
export const unlockRequest = (m: string, pin: string) => call<Challenge>(m, "step-up/request", { pin });
/** Step 2: the code from the phone. Opens the vault for a few minutes. */
export const unlockVerify = (m: string, challengeId: string, code: string) => call<{ ok: true }>(m, "step-up/verify", { challenge_id: challengeId, code });
/** First time: send a code (to the given phone if the business has none yet), then choose the key with that code. */
export const enrollRequest = (m: string, phone?: string) => call<Challenge>(m, "vault/enroll/request", phone ? { phone } : {});
export const enrollVerify = (m: string, challengeId: string, code: string, pin: string, phone?: string) => call<{ ok: true }>(m, "vault/enroll/verify", { challenge_id: challengeId, code, pin, ...(phone ? { phone } : {}) });
/** Forgot the key: a code to the registered phone (and, for an owner verified with Fayda, a Fayda check follows). */
export const resetRequest = (m: string) => call<Challenge>(m, "vault/reset/request", {});
export const resetFayda = (m: string, fan: string) => call<{ fayda_session_id: string; phone_hint: string | null }>(m, "vault/reset/fayda", { fan });
export const resetVerify = (m: string, body: { challenge_id: string; code: string; pin: string; fayda_session_id?: string; fayda_otp?: string }) => call<{ ok: true }>(m, "vault/reset/verify", body);
async function save(merchantId: string, input: SettlementInput): Promise<SettlementView> {
  const res = await fetch(`/api/merchants/${merchantId}/settlement`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && (data.code === "STEP_UP_REQUIRED" || data.code === "VAULT_SETUP_REQUIRED")) throw new StepUpRequiredError();
  if (!res.ok) throw new Error(data.error ?? "save");
  return data as SettlementView;
}

const keep = (list: MaskedAccount[]): AccountEntry[] => list.map((a) => ({ id: a.id }));

/** The current state as a save request: existing accounts are kept by id (their numbers never leave the server). */
function asInput(v: SettlementView): SettlementInput {
  return { banks: keep(v.saved_banks), wallets: keep(v.saved_wallets), active_bank_id: v.active_bank_id, active_wallet_id: v.active_wallet_id };
}

export async function addAccount(merchantId: string, v: SettlementView, kind: SettlementKind, institution: string, accountNumber: string, makeActive: boolean) {
  const id = crypto.randomUUID();
  const next = asInput(v);
  const entry: AccountEntry = { id, institution, account_number: accountNumber };
  const list = kind === "bank" ? next.banks : next.wallets;
  list.push(entry);
  // The first account of a kind becomes the active one automatically; later ones only if the merchant chose so.
  const activeKey = kind === "bank" ? "active_bank_id" : "active_wallet_id";
  if (makeActive || !next[activeKey]) next[activeKey] = id;
  return save(merchantId, next);
}

export async function removeAccount(merchantId: string, v: SettlementView, kind: SettlementKind, id: string) {
  const next = asInput(v);
  const list = (kind === "bank" ? next.banks : next.wallets).filter((a) => a.id !== id);
  if (kind === "bank") next.banks = list;
  else next.wallets = list;
  const activeKey = kind === "bank" ? "active_bank_id" : "active_wallet_id";
  if (next[activeKey] === id) next[activeKey] = list[0]?.id ?? null; // never leave a kind with accounts but none active
  return save(merchantId, next);
}

export async function activateAccount(merchantId: string, v: SettlementView, kind: SettlementKind, id: string) {
  const next = asInput(v);
  next[kind === "bank" ? "active_bank_id" : "active_wallet_id"] = id;
  return save(merchantId, next);
}
