import type { Metadata } from "next";
import type { Language } from "@/components/LanguageProvider";

export const SITE_ORIGIN = "https://tomverse.app";
export const SITE_NAME = "Tomverse AI";

export const SEO_LOCALES: readonly Language[] = [
  "en",
  "ko",
  "zh",
  "fr",
  "de",
  "es",
  "pt",
] as const;

export const LOCALIZED_SEO_PATHS = [
  "/",
  "/compare-ai-models",
  "/ai-answer-review",
  "/chatgpt-vs-claude",
  "/ai-for-file-analysis",
] as const;

const hreflangByLocale: Record<Language, string> = {
  en: "en",
  ko: "ko",
  zh: "zh-CN",
  fr: "fr",
  de: "de",
  es: "es",
  pt: "pt",
};

const openGraphLocaleByLanguage: Record<Language, string> = {
  en: "en_AU",
  ko: "ko_KR",
  zh: "zh_CN",
  fr: "fr_FR",
  de: "de_DE",
  es: "es_ES",
  pt: "pt_BR",
};

export const isSeoLocale = (value: string): value is Language =>
  SEO_LOCALES.includes(value.toLowerCase() as Language);

export const localizedPath = (locale: Language, basePath: string) =>
  basePath === "/" ? `/${locale}` : `/${locale}${basePath}`;

export const localizedLanguageAlternates = (basePath: string) => {
  const languages: Record<string, string> = {
    "x-default": `${SITE_ORIGIN}${basePath}`,
  };
  for (const locale of SEO_LOCALES) {
    languages[hreflangByLocale[locale]] = `${SITE_ORIGIN}${localizedPath(
      locale,
      basePath
    )}`;
  }
  return languages;
};

type PageMetadataOptions = {
  title: string;
  description: string;
  path: string;
  locale?: Language;
  localizedBasePath?: string;
  noIndex?: boolean;
};

export const createPageMetadata = ({
  title,
  description,
  path,
  locale = "en",
  localizedBasePath,
  noIndex = false,
}: PageMetadataOptions): Metadata => ({
  title,
  description,
  alternates: {
    canonical: `${SITE_ORIGIN}${path}`,
    ...(localizedBasePath
      ? { languages: localizedLanguageAlternates(localizedBasePath) }
      : {}),
  },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title,
    description,
    url: `${SITE_ORIGIN}${path}`,
    locale: openGraphLocaleByLanguage[locale],
    alternateLocale: SEO_LOCALES.filter((item) => item !== locale).map(
      (item) => openGraphLocaleByLanguage[item]
    ),
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Tomverse AI — compare leading AI models in one workspace",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [
      {
        url: "/twitter-image",
        alt: "Tomverse AI — compare leading AI models in one workspace",
      },
    ],
  },
  ...(noIndex
    ? {
        robots: {
          index: false,
          follow: false,
          nocache: true,
          googleBot: {
            index: false,
            follow: false,
            noimageindex: true,
          },
        },
      }
    : {}),
});

export const homeSeoCopy: Record<
  Language,
  { title: string; description: string }
> = {
  en: {
    title: "Compare AI Answers and Cross-Review What They Missed",
    description:
      "Ask multiple AI models once, compare their answers, and use Tomverse AI Review to organize agreements, contradictions, omissions, and verification needs.",
  },
  ko: {
    title: "여러 AI 답변을 비교하고 놓친 부분까지 교차검토하세요",
    description:
      "한 번 질문해 여러 AI 답변을 비교하고 Tomverse AI Review로 합의점, 모순, 누락과 추가 검증 항목을 구조화하세요.",
  },
  zh: {
    title: "比较多个 AI 回答并交叉审查遗漏",
    description:
      "一次向多个 AI 提问、比较回答，并使用 Tomverse AI Review 整理共识、矛盾、遗漏和待核实项目。",
  },
  fr: {
    title: "Comparez les réponses IA et examinez leurs omissions",
    description:
      "Posez une question à plusieurs modèles, comparez leurs réponses et utilisez Tomverse AI Review pour structurer accords, contradictions et points à vérifier.",
  },
  de: {
    title: "KI-Antworten vergleichen und Auslassungen gegenprüfen",
    description:
      "Fragen Sie mehrere KI-Modelle einmal, vergleichen Sie Antworten und ordnen Sie mit Tomverse AI Review Gemeinsamkeiten, Widersprüche und Prüfbedarf.",
  },
  es: {
    title: "Compara respuestas de IA y revisa lo que dejaron fuera",
    description:
      "Pregunta una vez a varios modelos, compara sus respuestas y usa Tomverse AI Review para organizar acuerdos, contradicciones, omisiones y verificaciones.",
  },
  pt: {
    title: "Compare respostas de IA e revise o que ficou de fora",
    description:
      "Pergunte uma vez a vários modelos, compare respostas e use o Tomverse AI Review para organizar consensos, contradições, omissões e verificações.",
  },
};
