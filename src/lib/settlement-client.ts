import type { SettlementKind } from "@/lib/constants";
import type { AccountEntry, MaskedAccount, SettlementInput, SettlementView } from "@/lib/settlement";

/** Browser-side calls for the merchant's payment accounts. Every change is saved immediately (no big "Save" form). */
export async function loadSettlement(merchantId: string): Promise<SettlementView> {
  const res = await fetch(`/api/merchants/${merchantId}/settlement`, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "load");
  return data as SettlementView;
}

async function save(merchantId: string, input: SettlementInput): Promise<SettlementView> {
  const res = await fetch(`/api/merchants/${merchantId}/settlement`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => ({}));
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
