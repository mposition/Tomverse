import type { Language } from "@/lib/language";
import type { HelpLocaleCopy } from "../types";
import { de } from "./de";
import { en } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { ko } from "./ko";
import { pt } from "./pt";
import { zh } from "./zh";
import { zhHant } from "./zh-Hant";

/** Server-side only: pages pass the reader's one locale down as a prop. */
export const HELP_COPY: Record<Language, HelpLocaleCopy> = {
  ko,
  en,
  zh,
  "zh-Hant": zhHant,
  fr,
  de,
  es,
  pt,
};

export const helpCentreCopy = (lang: Language): HelpLocaleCopy => HELP_COPY[lang];
