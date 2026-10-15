/** Ethiopian settlement institutions a merchant can receive into. */
export const BANKS = [
  "Commercial Bank of Ethiopia (CBE)",
  "Development Bank of Ethiopia (DBE)",
  "Abay Bank",
  "Addis International Bank",
  "Ahadu Bank",
  "Amhara Bank",
  "Awash Bank",
  "Bank of Abyssinia",
  "Berhan Bank",
  "Bunna International Bank",
  "Cooperative Bank of Oromia",
  "Dashen Bank",
  "Debub Global Bank",
  "Enat Bank",
  "Gadaa Bank",
  "Global Bank Ethiopia",
  "Goh Betoch Bank",
  "Hibret Bank",
  "Lion International Bank",
  "Nib International Bank",
  "Oromia Bank",
  "Rammis Bank",
  "Shabelle Bank",
  "Sidama Bank",
  "Siinqee Bank",
  "Siket Bank",
  "Tsedey Bank",
  "Tsehay Bank",
  "Wegagen Bank",
  "Zemen Bank",
  "Hijra Bank",
  "ZamZam Bank",
] as const;

export const WALLETS = [
  "Telebirr",
  "M-Pesa",
  "Kacha",
  "YaYa Wallet",
  "Amole",
  "CBE Birr",
  "CBE Connect",
  "HelloCash",
  "AwashBirr",
  "Vitabirr",
  "ToloPay",
] as const;

export type Bank = (typeof BANKS)[number];
export type Wallet = (typeof WALLETS)[number];

/** Maximum saved accounts per kind (banks, wallets). */
export const MAX_SAVED = 3;

export type SettlementKind = "bank" | "wallet";

export const isBank = (name: string): name is Bank => (BANKS as readonly string[]).includes(name);
export const isWallet = (name: string): name is Wallet => (WALLETS as readonly string[]).includes(name);

/** Shown first in the pickers so most merchants find theirs without searching. */
export const POPULAR_BANKS: Bank[] = [
  "Commercial Bank of Ethiopia (CBE)",
  "Awash Bank",
  "Dashen Bank",
  "Bank of Abyssinia",
  "Wegagen Bank",
  "Nib International Bank",
];
export const POPULAR_WALLETS: Wallet[] = ["Telebirr", "CBE Birr", "M-Pesa"];

/** Short badge text for an institution: the abbreviation in brackets if it has one, else its first two letters. */
export function shortName(name: string): string {
  const m = /\(([A-Z]{2,5})\)/.exec(name);
  if (m) return m[1];
  const word = name.split(/\s+/)[0] ?? name;
  return word.slice(0, 2).toUpperCase();
}

/** A stable hue (0-359) per institution, so each keeps the same badge colour everywhere. */
export function hueFor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** The tap-to-confirmation speed 2Pay aims for, in seconds (shown on the admin dashboard). */
export const LATENCY_TARGET_S = 2.0;
