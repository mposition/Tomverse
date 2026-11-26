import type { Language } from "../../../../lib/language";
import { en } from "../../../../locales/en";
import { ko } from "../../../../locales/ko";
import { zh } from "../../../../locales/zh";
import { zhHant } from "../../../../locales/zhHant";
import { fr } from "../../../../locales/fr";
import { de } from "../../../../locales/de";
import { es } from "../../../../locales/es";
import { pt } from "../../../../locales/pt";

/** The shared web dictionaries, so answer extras reuse the exact sentences the web product shows. */
export const webLocales = { en, ko, zh, "zh-Hant": zhHant, fr, de, es, pt } satisfies Record<Language, typeof en>;
