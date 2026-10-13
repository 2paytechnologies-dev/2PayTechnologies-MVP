import { BANKS, POPULAR_BANKS, POPULAR_WALLETS, WALLETS } from "@/lib/constants";

/**
 * The customer routing hub. A web page cannot see which bank or wallet apps are installed on a phone (iOS and Android both
 * forbid it), so we do not guess: the customer taps THEIR app on a grid, and we pick the best of the merchant's own active
 * accounts to receive it. Pure functions, unit tested.
 */

export type PayerKind = "bank" | "wallet";
export interface PayerApp {
  name: string;
  kind: PayerKind;
}

/** Shown first: the apps most customers use. The rest of the national list is one tap away. */
export const POPULAR_PAYER_APPS: PayerApp[] = [...POPULAR_WALLETS.map((name) => ({ name, kind: "wallet" as const })), ...POPULAR_BANKS.map((name) => ({ name, kind: "bank" as const }))];
export const ALL_PAYER_APPS: PayerApp[] = [...WALLETS.map((name) => ({ name, kind: "wallet" as const })), ...BANKS.map((name) => ({ name, kind: "bank" as const }))];

/** A customer-chosen app, only if it is a known national bank or wallet (anything else is rejected, never stored). */
export function findPayerApp(name: unknown): PayerApp | null {
  if (typeof name !== "string") return null;
  return ALL_PAYER_APPS.find((a) => a.name === name) ?? null;
}

/** Wallets that belong to a bank: paying from one to that bank's account is an internal transfer (fastest, usually free). */
const FAMILY: Record<string, string> = {
  "CBE Birr": "Commercial Bank of Ethiopia (CBE)",
  "CBE Connect": "Commercial Bank of Ethiopia (CBE)",
  AwashBirr: "Awash Bank",
};
export const familyOf = (name: string): string => FAMILY[name] ?? name;

export type RouteReason = "same-institution" | "same-kind" | "only-option";
export interface Route {
  method: PayerKind;
  /** The merchant's account that receives this payment. */
  institution: string;
  reason: RouteReason;
}

/**
 * Which of the merchant's active accounts should receive a payment from this customer app?
 *  1. Same institution (or same bank family): an internal transfer, so use it.
 *  2. Same kind: a wallet customer pays the merchant's wallet, a bank customer the merchant's bank.
 *  3. Only one account configured: that one.
 * Returns null when the merchant has no active account.
 */
export function chooseRoute(app: PayerApp | null, merchant: { bank: string | null; wallet: string | null }): Route | null {
  const { bank, wallet } = merchant;
  if (!bank && !wallet) return null;
  if (bank && !wallet) return { method: "bank", institution: bank, reason: "only-option" };
  if (wallet && !bank) return { method: "wallet", institution: wallet, reason: "only-option" };
  if (!app) return { method: "wallet", institution: wallet!, reason: "only-option" };
  const mine = familyOf(app.name);
  if (familyOf(bank!) === mine) return { method: "bank", institution: bank!, reason: "same-institution" };
  if (familyOf(wallet!) === mine) return { method: "wallet", institution: wallet!, reason: "same-institution" };
  return app.kind === "wallet" ? { method: "wallet", institution: wallet!, reason: "same-kind" } : { method: "bank", institution: bank!, reason: "same-kind" };
}