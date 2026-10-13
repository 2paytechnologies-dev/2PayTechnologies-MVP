import { common } from "./sections/common";
import { portal } from "./sections/portal";
import { terminal } from "./sections/terminal";
import { accounts } from "./sections/accounts";
import { sales } from "./sections/sales";
import { today } from "./sections/today";
import { business } from "./sections/business";
import { auth } from "./sections/auth";
import { payer } from "./sections/payer";
import { download } from "./sections/download";
import { crew } from "./sections/crew";

/**
 * Every string in the app, per language. Each section is declared with `define`, so the Amharic side of a section can
 * never miss a key the English side has (TypeScript refuses to compile), and tests check nothing is left blank.
 * To add a language (Oromo, Tigrinya): add its object to each section, add it to `Lang`/`LANGS`, and add it here.
 */
export const en = { ...common.en, ...portal.en, ...terminal.en, ...accounts.en, ...sales.en, ...today.en, ...business.en, ...auth.en, ...payer.en, ...download.en, ...crew.en } as const;
export const am = { ...common.am, ...portal.am, ...terminal.am, ...accounts.am, ...sales.am, ...today.am, ...business.am, ...auth.am, ...payer.am, ...download.am, ...crew.am };

export type Key = keyof typeof en;
export const dict: { en: Record<Key, string>; am: Record<Key, string> } = { en, am };
