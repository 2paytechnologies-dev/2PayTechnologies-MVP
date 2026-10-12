"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { dict, type Key } from "./dict";
import { DEFAULT_LANG, LANG_STORAGE_KEY, format, pickInitialLang, type Lang, type Vars } from "./core";

export type { Lang, Key };
export { LANGS } from "./core";

interface Ctx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: Key, vars?: Vars) => string;
}

const I18nContext = createContext<Ctx>({
  lang: DEFAULT_LANG,
  setLang: () => {},
  t: (key, vars) => format(dict.en[key] ?? key, vars),
});

/** Wrap the app once (see layout.tsx). Remembers the choice on this device and starts in Amharic on Amharic phones. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(DEFAULT_LANG);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(LANG_STORAGE_KEY);
    } catch {
      /* storage unavailable: use the phone's language */
    }
    setLangState(pickInitialLang(saved, navigator.language));
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<Ctx>(
    () => ({ lang, setLang, t: (key, vars) => format(dict[lang][key] ?? dict.en[key] ?? key, vars) }),
    [lang, setLang],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);

/** Shorthand for components that only need to translate. */
export const useT = () => useContext(I18nContext).t;
