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

export const studioStickerSuggestions = {
  en: ["Love you!", "Good morning!", "You got this!", "My bad", "No worries", "On my way!", "Miss you", "Can't wait", "Wow!", "Same here", "I'm in!", "Take care"],
  ko: ["사랑해", "좋은 아침", "힘내!", "괜찮아", "보고 싶어", "기대돼", "대박!", "나도!", "콜!", "조심히 가", "잘했어", "신난다"],
  zh: ["我爱你", "早上好", "加油！", "对不起", "没关系", "在路上", "想你了", "好期待", "太好了", "我也是", "算我一个", "路上小心"],
  "zh-Hant": ["我愛你", "早安", "加油！", "對不起", "沒關係", "在路上", "想你了", "好期待", "太棒了", "我也是", "算我一個", "路上小心"],
  fr: ["Je t'aime", "Coucou !", "Courage !", "Pardon", "Pas de souci", "J'arrive !", "Tu me manques", "J'ai hâte", "Waouh !", "Moi aussi", "Je suis partant !", "Prends soin de toi"],
  de: ["Hab dich lieb!", "Guten Morgen!", "Du schaffst das!", "Tut mir leid", "Kein Problem", "Bin unterwegs!", "Vermisse dich", "Ich freu mich!", "Wow!", "Ich auch", "Bin dabei!", "Pass auf dich auf"],
  es: ["¡Te quiero!", "¡Buen día!", "¡Tú puedes!", "Perdón", "No pasa nada", "¡Ya voy!", "Te extraño", "¡Qué ganas!", "¡Guau!", "Yo también", "¡Me apunto!", "Cuídate"],
  pt: ["Te amo!", "Bom dia!", "Você consegue!", "Foi mal", "Tudo bem", "Tô a caminho!", "Saudade", "Mal posso esperar", "Uau!", "Eu também", "Tô dentro!", "Se cuida"],
} satisfies Record<Language, readonly string[]>;

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
