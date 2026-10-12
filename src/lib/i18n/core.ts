/**
 * Minimal, dependency-free i18n. Each screen owns a section of strings; a section is written once in English and
 * once in Amharic through `define`, and TypeScript refuses to compile if the Amharic side misses a key.
 */
export type Lang = "en" | "am";

export const LANGS: { code: Lang; label: string }[] = [
  { code: "en", label: "English" },
  { code: "am", label: "አማርኛ" },
];

export const DEFAULT_LANG: Lang = "en";
export const LANG_STORAGE_KEY = "2pay:lang";

export const isLang = (v: unknown): v is Lang => v === "en" || v === "am";

/** Write a section: the Amharic object must have exactly the English object's keys. */
export function define<T extends Record<string, string>>(en: T, am: { [K in keyof T]: string }) {
  return { en, am } as const;
}

export type Vars = Record<string, string | number>;

/** Replace {name} placeholders. A missing variable is left visible ({name}) rather than silently dropped. */
export function format(template: string, vars?: Vars): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (vars && k in vars ? String(vars[k]) : `{${k}}`));
}

/** The language to start in: a saved choice, else Amharic for Amharic-language phones, else English. */
export function pickInitialLang(saved: string | null | undefined, browser: string | null | undefined): Lang {
  if (isLang(saved)) return saved;
  return (browser ?? "").toLowerCase().startsWith("am") ? "am" : DEFAULT_LANG;
}
