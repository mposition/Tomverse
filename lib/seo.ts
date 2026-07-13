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
    title: "Compare Leading AI Models in One Workspace",
    description:
      "Compare answers from leading AI models side by side, analyze files, ask follow-up questions, and organize useful conversations with Tomverse AI.",
  },
  ko: {
    title: "여러 AI 모델을 한 워크스페이스에서 비교하세요",
    description:
      "Tomverse AI에서 주요 AI 모델의 답변을 나란히 비교하고, 파일을 분석하고, 후속 질문과 유용한 대화를 한곳에서 관리하세요.",
  },
  zh: {
    title: "在一个工作区比较主流 AI 模型",
    description:
      "使用 Tomverse AI 并排比较主流 AI 模型的回答、分析文件、继续追问并整理有用的对话。",
  },
  fr: {
    title: "Comparez les principaux modèles d’IA dans un seul espace",
    description:
      "Comparez les réponses de plusieurs modèles d’IA, analysez des fichiers, posez des questions de suivi et organisez vos conversations avec Tomverse AI.",
  },
  de: {
    title: "Führende KI-Modelle in einem Workspace vergleichen",
    description:
      "Vergleichen Sie Antworten führender KI-Modelle, analysieren Sie Dateien, stellen Sie Folgefragen und organisieren Sie Unterhaltungen mit Tomverse AI.",
  },
  es: {
    title: "Compara los principales modelos de IA en un solo espacio",
    description:
      "Compara respuestas de varios modelos de IA, analiza archivos, haz preguntas de seguimiento y organiza conversaciones con Tomverse AI.",
  },
  pt: {
    title: "Compare os principais modelos de IA em um só workspace",
    description:
      "Compare respostas de vários modelos de IA, analise arquivos, faça perguntas de acompanhamento e organize conversas com o Tomverse AI.",
  },
};
