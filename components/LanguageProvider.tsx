// components/LanguageProvider.tsx
"use client";

import React, { createContext, useCallback, useContext, useState } from "react";
import { ko } from "@/locales/ko";
import { en } from "@/locales/en";
import { zh } from "@/locales/zh";

export type Language = "ko" | "en" | "zh";

interface LanguageContextType {
    lang: Language;
    setLang: (lang: Language) => void;
    t: (key: string) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

const dictionaries = { ko, en, zh };
const LANGUAGE_STORAGE_KEY = "tomverse_language";

const isLanguage = (value: unknown): value is Language =>
    value === "ko" || value === "en" || value === "zh";

export function LanguageProvider({ children, initialLang = "en" }: { children: React.ReactNode, initialLang?: Language }) {
    const [lang, setLangState] = useState<Language>(() => {
        if (typeof window === "undefined") return initialLang;

        const savedLanguage = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
        return isLanguage(savedLanguage) ? savedLanguage : initialLang;
    });

    const setLang = useCallback((nextLang: Language) => {
        setLangState(nextLang);
        if (typeof window !== "undefined") {
            window.localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLang);
        }
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
