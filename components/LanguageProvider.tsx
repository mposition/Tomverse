// components/LanguageProvider.tsx
"use client";

import React, { createContext, useContext, useState, useEffect } from "react";
import { ko } from "@/locales/ko";
import { en } from "@/locales/en";
import { zh } from "@/locales/zh";

type Language = "ko" | "en" | "zh";
type Translations = typeof ko;

interface LanguageContextType {
    lang: Language;
    setLang: (lang: Language) => void;
    t: (key: string) => string; // 💡 번역본을 꺼내주는 핵심 함수
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

const dictionaries = { ko, en, zh };

export function LanguageProvider({ children, initialLang = "en" }: { children: React.ReactNode, initialLang?: Language }) {
    const [lang, setLang] = useState<Language>(initialLang);

    // 💡 중첩된 키(예: "sidebar.newChat")를 해석해서 문자열을 반환하는 함수
    const t = (key: string) => {
        const keys = key.split(".");
        let value: any = dictionaries[lang];
        for (const k of keys) {
            if (value === undefined) break;
            value = value[k];
        }
        return (value as string) || key; // 번역이 없으면 키값 자체를 반환
    };

    return (
        <LanguageContext.Provider value={{ lang, setLang, t }}>
            {children}
        </LanguageContext.Provider>
    );
}

export const useLanguage = () => {
    const context = useContext(LanguageContext);
    if (!context) throw new Error("LanguageProvider 안에서 사용해야 합니다.");
    return context;
};