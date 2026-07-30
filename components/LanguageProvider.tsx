// components/LanguageProvider.tsx
"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ko } from "@/locales/ko";
import { en } from "@/locales/en";
import { zh } from "@/locales/zh";
import { fr } from "@/locales/fr";
import { de } from "@/locales/de";
import { es } from "@/locales/es";
import { pt } from "@/locales/pt";
import { isLanguage, type Language } from "@/lib/language";

export type { Language };

interface LanguageContextType {
    lang: Language;
    setLang: (lang: Language) => void;
    t: (key: string) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

const dictionaries = { ko, en, zh, fr, de, es, pt };
const LANGUAGE_STORAGE_KEY = "tomverse_language";

/**
 * R-05-LANG. The same preference as `LANGUAGE_STORAGE_KEY`, mirrored where the
 * proxy can see it.
 *
 * The proxy redirects a non-English visitor from `/` to their localized page so
 * the first byte already carries the right language. `localStorage` is
 * invisible to it, so without this a visitor who deliberately chose English on
 * a Korean browser would be sent back to `/ko` on every visit -- the client
 * respects that choice today and the redirect must not undo it.
 *
 * Functional only: it stores a language code the visitor picked, is not read by
 * analytics, and is deliberately not `HttpOnly` because the same code that
 * writes `localStorage` writes it.
 */
const LANGUAGE_COOKIE = "tomverse_lang";
const LANGUAGE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const persistLanguage = (nextLang: Language) => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLang);
    document.cookie =
        `${LANGUAGE_COOKIE}=${nextLang}; path=/; max-age=${LANGUAGE_COOKIE_MAX_AGE}; samesite=lax` +
        (window.location.protocol === "https:" ? "; secure" : "");
};

const lookup = (dictionary: unknown, keys: string[]) => {
    let value = dictionary;
    for (const k of keys) {
        if (!value || typeof value !== "object") return undefined;
        value = (value as Record<string, unknown>)[k];
    }
    return typeof value === "string" ? value : undefined;
};

const detectBrowserLanguage = (): Language | null => {
    if (typeof navigator === "undefined") return null;

    const candidates = [
        ...(Array.isArray(navigator.languages) ? navigator.languages : []),
        navigator.language,
    ];

    for (const candidate of candidates) {
        const normalized = candidate?.trim().toLowerCase();
        if (!normalized) continue;

        const baseLanguage = normalized.split("-")[0];
        if (isLanguage(baseLanguage)) return baseLanguage;
    }

    return null;
};

export function LanguageProvider({
    children,
    initialLang = "en",
    forceInitialLang = false,
}: {
    children: React.ReactNode;
    initialLang?: Language;
    forceInitialLang?: boolean;
}) {
    const [lang, setLangState] = useState<Language>(initialLang);

    const setLang = useCallback((nextLang: Language) => {
        setLangState(nextLang);
        if (typeof window !== "undefined") {
            persistLanguage(nextLang);
            document.documentElement.lang = nextLang;
        }
    }, []);

    useEffect(() => {
        document.documentElement.lang = lang;
    }, [lang]);

    useEffect(() => {
        if (forceInitialLang) {
            persistLanguage(initialLang);
            document.documentElement.lang = initialLang;
            return;
        }

        const restoreSavedLanguage = window.setTimeout(() => {
            const urlLanguage = new URLSearchParams(window.location.search).get("lang");
            if (isLanguage(urlLanguage)) {
                setLangState(urlLanguage);
                persistLanguage(urlLanguage);
                document.documentElement.lang = urlLanguage;
                return;
            }

            const savedLanguage = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
            if (isLanguage(savedLanguage)) {
                setLangState(savedLanguage);
                // Re-persisted, not just read: this is what carries an existing
                // visitor's stored choice into the cookie the proxy reads, so
                // preferences made before R-05-LANG keep being honoured.
                persistLanguage(savedLanguage);
                document.documentElement.lang = savedLanguage;
                return;
            }

            // Private browsing intentionally starts with isolated storage. On that
            // first visit, use the browser preference instead of silently falling
            // back to English and carrying `lang=en` into the chat CTA.
            const browserLanguage = detectBrowserLanguage();
            if (browserLanguage) {
                setLangState(browserLanguage);
                persistLanguage(browserLanguage);
                document.documentElement.lang = browserLanguage;
            }
        }, 0);

        return () => window.clearTimeout(restoreSavedLanguage);
    }, [forceInitialLang, initialLang]);

    // `t` and the context value are memoised on `lang` because consumers put
    // `t` in effect dependency arrays. When both were rebuilt on every render
    // of this provider, every one of those effects re-ran on renders that had
    // nothing to do with language -- including the chat panel's message-view
    // loader, where a re-run landing inside an in-flight fetch left the panel
    // stuck on its loading placeholder.
    const t = useCallback(
        (key: string) => {
            const keys = key.split(".");
            return lookup(dictionaries[lang], keys) ?? lookup(en, keys) ?? key;
        },
        [lang]
    );

    const contextValue = useMemo(
        () => ({ lang, setLang, t }),
        [lang, setLang, t]
    );

    return (
        <LanguageContext.Provider value={contextValue}>
            {children}
        </LanguageContext.Provider>
    );
}

export const useLanguage = () => {
    const context = useContext(LanguageContext);
    if (!context) throw new Error("useLanguage must be used inside LanguageProvider.");
    return context;
};
