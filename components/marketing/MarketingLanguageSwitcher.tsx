"use client";

import { Languages } from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";

const languageOptions: Array<{ value: Language; label: string }> = [
  { value: "ko", label: "한국어" },
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
];

export function MarketingLanguageSwitcher() {
  const { lang, setLang } = useLanguage();

  return (
    <label className="inline-flex h-10 items-center gap-2 rounded-xl border border-zinc-300 bg-white px-3 text-sm font-bold text-zinc-700 shadow-sm transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800">
      <Languages className="h-4 w-4 text-blue-600 dark:text-blue-400" />
      <span className="sr-only">Language</span>
      <select
        aria-label="Language"
        value={lang}
        onChange={(event) => setLang(event.target.value as Language)}
        className="cursor-pointer bg-transparent text-sm font-bold text-zinc-800 outline-none [color-scheme:light] dark:text-zinc-100 dark:[color-scheme:dark]"
      >
        {languageOptions.map((option) => (
          <option
            key={option.value}
            value={option.value}
            className="bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100"
          >
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
