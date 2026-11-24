import { Barlow_Semi_Condensed, Bricolage_Grotesque, Fraunces, Huninn, Jua, Nunito, Rubik, ZCOOL_QingKe_HuangYou } from "next/font/google";
import type { Language } from "@/lib/language";

const jua = Jua({ weight: "400", preload: false, adjustFontFallback: false });
const bricolage = Bricolage_Grotesque({ weight: "800", preload: false, adjustFontFallback: false });
const qingke = ZCOOL_QingKe_HuangYou({ weight: "400", preload: false, adjustFontFallback: false });
const huninn = Huninn({ weight: "400", preload: false, adjustFontFallback: false });
const fraunces = Fraunces({ weight: "700", preload: false, adjustFontFallback: false });
const barlow = Barlow_Semi_Condensed({ weight: "800", preload: false, adjustFontFallback: false });
const rubik = Rubik({ weight: "800", preload: false, adjustFontFallback: false });
const nunito = Nunito({ weight: "900", preload: false, adjustFontFallback: false });

const faces = {
  ko: jua,
  en: bricolage,
  zh: qingke,
  "zh-Hant": huninn,
  fr: fraunces,
  de: barlow,
  es: rubik,
  pt: nunito,
} satisfies Record<Language, typeof jua>;

export async function loadStudioStickerFont(language: Language, text: string) {
  const primary = faces[language].style;
  const root = getComputedStyle(document.documentElement);
  const fallbacks = [
    /\p{Script=Hangul}/u.test(text) && root.getPropertyValue("--font-noto-sans-kr").trim(),
    /\p{Script=Han}/u.test(text) && root.getPropertyValue(language === "zh-Hant" ? "--font-noto-sans-tc" : "--font-noto-sans-sc").trim(),
  ].filter(Boolean);
  const families = [primary.fontFamily, ...fallbacks];
  const weight = primary.fontWeight ?? 400;
  await Promise.allSettled(families.map(family => document.fonts.load(`${weight} 100px ${family}`, text)));
  return (size: number) => `${weight} ${size}px ${families.join(", ")}, sans-serif`;
}
