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

/**
 * What the customer's app has to do to send the money, which decides which screen of that app we open:
 *  - internal : the customer's institution IS the merchant's (or its family): the app's own "transfer within the bank/wallet".
 *  - interbank: the merchant's account is at a DIFFERENT bank: the app's "transfer to other banks" screen (the EthSwitch
 *               interbank transfer every bank app has), with the merchant's bank selected and the account filled in.
 *  - wallet   : the merchant's account is a different wallet: the app's "send to wallet / phone number" screen.
 */
export type Transfer = "internal" | "interbank" | "wallet";

export interface Route {
  method: PayerKind;
  /** The merchant's account that receives this payment. */
  institution: string;
  reason: RouteReason;
  transfer: Transfer;
}

/** Which transfer screen the customer's app needs for this merchant account. */
export function transferFor(app: PayerApp | null, merchantInstitution: string, merchantKind: PayerKind): Transfer {
  if (app && familyOf(app.name) === familyOf(merchantInstitution)) return "internal";
  return merchantKind === "bank" ? "interbank" : "wallet";
}

const route = (app: PayerApp | null, method: PayerKind, institution: string, reason: RouteReason): Route => ({ method, institution, reason, transfer: transferFor(app, institution, method) });

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
  if (bank && !wallet) return route(app, "bank", bank, "only-option");
  if (wallet && !bank) return route(app, "wallet", wallet, "only-option");
  if (!app) return route(app, "wallet", wallet!, "only-option");
  const mine = familyOf(app.name);
  if (familyOf(bank!) === mine) return route(app, "bank", bank!, "same-institution");
  if (familyOf(wallet!) === mine) return route(app, "wallet", wallet!, "same-institution");
  return app.kind === "wallet" ? route(app, "wallet", wallet!, "same-kind") : route(app, "bank", bank!, "same-kind");
}