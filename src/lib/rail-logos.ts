import { BANKS, WALLETS } from "@/lib/constants";

/**
 * Bank and wallet logos for the customer hub. Official marks belong to the institutions: they are supplied by each bank or wallet
 * (brand kit or written permission), dropped into `public/assets/rails/`, and listed in LOGO_FILES below. Nothing is invented or
 * redrawn here. Until a logo is listed, the hub shows the institution's styled initials badge, so every tile still looks finished.
 *
 * Lookup order of `getRailLogo`:
 *   1. a local file listed in LOGO_FILES (served from /assets/rails/, no third party involved),
 *   2. a CDN you operate or are licensed to use, if NEXT_PUBLIC_RAIL_LOGO_CDN is set (a URL containing {slug}),
 *   3. nothing ("") so the caller draws the initials badge.
 */

/** institution slug -> file in public/assets/rails/ (add an entry when a logo file has been supplied). */
export const LOGO_FILES: Record<string, string> = {
  // telebirr: "telebirr.svg",
  // cbe: "cbe.svg",
  // cbe-birr: "cbe-birr.svg",
  // awash-bank: "awash_bank.svg",
  // awashbirr: "awash_birr.svg",
  // dashen-bank: "dashen_bank.svg",
  // amole: "amole.svg",
  // bank-of-abyssinia: "bank_of_abyssinia.svg",
  // cooperative-bank-of-oromia: "coop_bank.svg",
  // arifpay: "arifpay.svg",
  // chapa: "chapa.svg",
};

export const LOGO_DIR = "/assets/rails";

/** Rail codes partners and providers use, mapped to the slug of the institution. */
const ALIASES: Record<string, string> = {
  telebirr: "telebirr",
  cbe: "cbe",
  commercial_bank_of_ethiopia_cbe: "cbe",
  cbe_birr: "cbe-birr",
  cbebirr: "cbe-birr",
  awash: "awash-bank",
  awash_bank: "awash-bank",
  awash_birr: "awashbirr",
  dashen: "dashen-bank",
  dashen_bank: "dashen-bank",
  boa: "bank-of-abyssinia",
  coop: "cooperative-bank-of-oromia",
  coop_bank: "cooperative-bank-of-oromia",
};

/** "Awash Bank" / "AWASH_BANK" / "awash-bank" -> "awash-bank". Parentheses (the CBE abbreviation) are dropped. */
export function railSlug(name: string): string {
  const flat = name.trim().toLowerCase().replace(/\(([a-z]+)\)/g, "$1").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return ALIASES[flat] ?? flat.replace(/_/g, "-");
}

/** The logo URL for a bank, wallet or rail code, or "" when there is none (draw the initials badge instead). */
export function getRailLogo(railCode: string, cdn: string | undefined = process.env.NEXT_PUBLIC_RAIL_LOGO_CDN): string {
  if (!railCode) return "";
  const slug = railSlug(railCode);
  const file = LOGO_FILES[slug];
  if (file) return `${LOGO_DIR}/${file}`;
  if (cdn && cdn.includes("{slug}") && /^https:\/\//.test(cdn)) return cdn.replace("{slug}", encodeURIComponent(slug));
  return "";
}

/** Every institution the hub can show, for tests and tooling. */
export const ALL_INSTITUTIONS: readonly string[] = [...WALLETS, ...BANKS];
