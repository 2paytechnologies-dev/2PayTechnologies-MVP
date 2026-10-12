import { describe, expect, it } from "vitest";
import { am, en } from "@/lib/i18n/dict";
import { DEFAULT_LANG, format, pickInitialLang } from "@/lib/i18n/core";
import { LEGAL } from "@/lib/i18n/legal-text";
import { localizeError } from "@/lib/i18n/errors";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const ETHIOPIC = /[ሀ-፿]/;

describe("translations", () => {
  const keys = Object.keys(en) as (keyof typeof en)[];

  it("Amharic has exactly the English keys", () => {
    expect(Object.keys(am).sort()).toEqual(Object.keys(en).sort());
  });

  it("no translation is blank", () => {
    for (const k of keys) {
      expect(en[k].length, `en ${k}`).toBeGreaterThan(0 + (k.endsWith(".pre") ? -1 : 0));
      if (!k.endsWith(".pre")) expect(am[k].trim().length, `am ${k}`).toBeGreaterThan(0);
    }
  });

  it("Amharic uses the same {placeholders} as English (a missing one would show raw text or drop a value)", () => {
    for (const k of keys) expect(placeholders(am[k]), `placeholders of ${k}`).toEqual(placeholders(en[k]));
  });

  it("Amharic strings are actually in Ethiopic script (catches an accidental English copy)", () => {
    // Allowed to stay Latin: pure brand/format strings, symbols or abbreviations.
    const allowLatin = new Set<string>(["common.appName", "terminal.category.Fuel", "terminal.category.Retail"]);
    const copied = keys.filter((k) => !allowLatin.has(k) && !ETHIOPIC.test(am[k]) && am[k] === en[k]);
    expect(copied).toEqual([]);
  });

  it("the Amharic legal documents have the same sections as the English ones", () => {
    for (const doc of ["terms", "privacy"] as const) {
      expect(LEGAL.am[doc].sections.length).toBe(LEGAL.en[doc].sections.length);
      LEGAL.am[doc].sections.forEach((s, i) => expect(s.body.length, `${doc} section ${i + 1}`).toBe(LEGAL.en[doc].sections[i].body.length));
    }
  });
});

describe("format and language choice", () => {
  it("fills placeholders and leaves unknown ones visible", () => {
    expect(format("Pay {name}", { name: "Awash Bank" })).toBe("Pay Awash Bank");
    expect(format("{n} of {max}", { n: 2 })).toBe("2 of {max}");
  });

  it("starts in the saved language, else Amharic on an Amharic phone, else English", () => {
    expect(pickInitialLang("am", "en-US")).toBe("am");
    expect(pickInitialLang("en", "am-ET")).toBe("en");
    expect(pickInitialLang(null, "am-ET")).toBe("am");
    expect(pickInitialLang(undefined, "fr-FR")).toBe(DEFAULT_LANG);
    expect(pickInitialLang("xx", undefined)).toBe(DEFAULT_LANG);
  });

  it("translates known server messages and passes unknown ones through", () => {
    const t = (k: keyof typeof en) => am[k];
    expect(localizeError("Token invalid, used or expired", t)).toBe(am["err.tokenInvalid"]);
    expect(localizeError("Something nobody planned for", t)).toBe("Something nobody planned for");
  });
});
