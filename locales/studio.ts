import type { Language } from "@/lib/language";
import { studioLocale as en } from "./studio.en";
import { studioLocale as ko } from "./studio.ko";
import { studioLocale as zh } from "./studio.zh";
import { studioLocale as zhHant } from "./studio.zh-Hant";
import { studioLocale as fr } from "./studio.fr";
import { studioLocale as de } from "./studio.de";
import { studioLocale as es } from "./studio.es";
import { studioLocale as pt } from "./studio.pt";

type StudioCopy = Readonly<Record<keyof typeof en, string>>;

export const studioCopy = { en, ko, zh, "zh-Hant": zhHant, fr, de, es, pt } satisfies Record<Language, StudioCopy>;

export const studioOutputLanguage = {
  en: "English",
  ko: "Korean",
  zh: "Simplified Chinese",
  "zh-Hant": "Traditional Chinese",
  fr: "French",
  de: "German",
  es: "Spanish",
  pt: "Portuguese",
} satisfies Record<Language, string>;
