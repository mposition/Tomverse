// components/LanguageProvider.tsx
"use client";

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { ko } from "@/locales/ko";
import { en } from "@/locales/en";
import { zh } from "@/locales/zh";
import { fr } from "@/locales/fr";
import { de } from "@/locales/de";

export type Language = "ko" | "en" | "zh" | "fr" | "de";

interface LanguageContextType {
    lang: Language;
    setLang: (lang: Language) => void;
    t: (key: string) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

const dictionaries = { ko, en, zh, fr, de };
const LANGUAGE_STORAGE_KEY = "tomverse_language";

const isLanguage = (value: unknown): value is Language =>
    value === "ko" ||
    value === "en" ||
    value === "zh" ||
    value === "fr" ||
    value === "de";

export function LanguageProvider({ children, initialLang = "en" }: { children: React.ReactNode, initialLang?: Language }) {
    const [lang, setLangState] = useState<Language>(initialLang);

    const setLang = useCallback((nextLang: Language) => {
        setLangState(nextLang);
        if (typeof window !== "undefined") {
            window.localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLang);
            document.documentElement.lang = nextLang;
        }
    }, []);

    useEffect(() => {
        document.documentElement.lang = lang;
    }, [lang]);

    useEffect(() => {
        const restoreSavedLanguage = window.setTimeout(() => {
            const savedLanguage = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
            if (isLanguage(savedLanguage)) {
                setLangState(savedLanguage);
                document.documentElement.lang = savedLanguage;
            }
        }, 0);

        return () => window.clearTimeout(restoreSavedLanguage);
    }, []);

    const t = (key: string) => {
        const keys = key.split(".");
        let value: unknown = dictionaries[lang];
        for (const k of keys) {
            if (!value || typeof value !== "object") return key;
            value = (value as Record<string, unknown>)[k];
        }
        return typeof value === "string" ? value : key;
    };

    return (
        <LanguageContext.Provider value={{ lang, setLang, t }}>
            {children}
        </LanguageContext.Provider>
    );
}

export const useLanguage = () => {
    const context = useContext(LanguageContext);
    if (!context) throw new Error("useLanguage must be used inside LanguageProvider.");
    return context;
};
