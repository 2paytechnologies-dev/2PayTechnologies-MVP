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
