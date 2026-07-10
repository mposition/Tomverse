// components/LanguageProvider.tsx
"use client";

import React, { createContext, useContext, useState } from "react";
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

export function LanguageProvider({ children, initialLang = "en" }: { children: React.ReactNode, initialLang?: Language }) {
    const [lang, setLang] = useState<Language>(initialLang);

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
    if (!context) throw new Error("LanguageProvider ì•ˆì—ì„œ ì‚¬ìš©í•´ì•¼ í•©ë‹ˆë‹¤.");
    return context;
};
