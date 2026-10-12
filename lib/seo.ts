import type { Metadata } from "next";
import type { Language } from "@/lib/language";
import { LOCALIZED_MARKETING_BASE_PATHS } from "@/lib/marketingRoutes";

export const SITE_ORIGIN = "https://tomverse.app";
export const SITE_NAME = "Tomverse";

export const SEO_LOCALES: readonly Language[] = [
  "en",
  "ko",
  "zh",
  "fr",
  "de",
  "es",
  "pt",
] as const;

export const LOCALIZED_SEO_PATHS = LOCALIZED_MARKETING_BASE_PATHS;

// SEO-I18N-01 (2026-09-17). `zh` is Simplified Chinese for readers
// anywhere, so its hreflang names the script, not a region: `zh-Hans`.
// `zh-CN` targeted mainland China, which Tomverse does not serve. This is
// the one place the tag is written -- page metadata and app/sitemap.ts both
// read it through localizedLanguageAlternates() -- so the pages that point at
// /zh change with it. The URL (/zh), the stored language key, the Open Graph
// locale below (a different, language_TERRITORY format) and the zh-CN used to
// format dates and prices are separate decisions and are not changed here.
const hreflangByLocale: Record<Language, string> = {
  en: "en",
  ko: "ko",
  zh: "zh-Hans",
  fr: "fr",
  de: "de",
  es: "es",
  pt: "pt",
};

// `en` maps to en_AU deliberately: Australia is the English-language market
// this surface is written for. lib/billingMarkets.ts carries the corroborating
// wiring -- AUD is one of the five billing currencies, `AU` resolves to it, an
// `Australia/*` time zone resolves to `AU`, and AUD is the one currency whose
// display locale is pinned to `en-AU`. (The *default* currency is USD; AUD is
// a market, not the fallback.)
//
// Recorded here because the 2026-07-30 landing audit flagged the value as
// unexplained rather than wrong, and the original decision is not written down
// anywhere else. Do not "correct" it to en_US as a tidy-up: it is the region
// signal every OG consumer reads, so changing it is a market decision.
const openGraphLocaleByLanguage: Record<Language, string> = {
  en: "en_AU",
  ko: "ko_KR",
  zh: "zh_CN",
  fr: "fr_FR",
  de: "de_DE",
  es: "es_ES",
  pt: "pt_BR",
};

const socialImageAlt: Record<Language, string> = {
  en: "Tomverse — Chat and Review with GPT, Claude, and Gemini in one place",
  ko: "Tomverse — GPT, Claude, Gemini를 한곳에서 사용하는 Chat과 Review",
  zh: "Tomverse — 在一个地方使用 GPT、Claude 和 Gemini 的 Chat 与 Review",
  fr: "Tomverse — Chat et Review avec GPT, Claude et Gemini au même endroit",
  de: "Tomverse — Chat und Review mit GPT, Claude und Gemini an einem Ort",
  es: "Tomverse — Chat y Review con GPT, Claude y Gemini en un solo lugar",
  pt: "Tomverse — Chat e Review com GPT, Claude e Gemini em um só lugar",
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

export const localizedQueryPath = (locale: Language, basePath: string) =>
  `${basePath}?lang=${locale}`;

export const queryLanguageAlternates = (basePath: string) => ({
  "x-default": `${SITE_ORIGIN}${localizedQueryPath("en", basePath)}`,
  ...Object.fromEntries(SEO_LOCALES.map(locale => [hreflangByLocale[locale],
    `${SITE_ORIGIN}${localizedQueryPath(locale, basePath)}`])),
});

type PageMetadataOptions = {
  title: string;
  description: string;
  path: string;
  locale?: Language;
  localizedBasePath?: string;
  noIndex?: boolean;
  ogTitle?: string;
  ogDescription?: string;
  absoluteTitle?: boolean;
};

export const createPageMetadata = ({
  title,
  description,
  path,
  locale = "en",
  localizedBasePath,
  noIndex = false,
  ogTitle,
  ogDescription,
  absoluteTitle = false,
}: PageMetadataOptions): Metadata => ({
  title: absoluteTitle ? { absolute: title } : title,
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
    title: ogTitle ?? title,
    description: ogDescription ?? description,
    url: `${SITE_ORIGIN}${path}`,
    locale: openGraphLocaleByLanguage[locale],
    alternateLocale: SEO_LOCALES.filter((item) => item !== locale).map(
      (item) => openGraphLocaleByLanguage[item]
    ),
    images: [
      {
        url: `${SITE_ORIGIN}/opengraph-image`,
        width: 1200,
        height: 630,
        alt: socialImageAlt[locale],
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: ogTitle ?? title,
    description: ogDescription ?? description,
    images: [
      {
        url: `${SITE_ORIGIN}/twitter-image`,
        alt: socialImageAlt[locale],
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

export const reviewSeoCopy: Record<
  Language,
  { title: string; description: string }
> = {
  en: {
    title: "Compare AI Answers and Cross-Review What They Missed",
    description:
      "Ask multiple AI models once, compare their answers, and use AI Review to organize agreements, contradictions and omissions — with web search and Deep Research for the claims that need checking.",
  },
  ko: {
    title: "여러 AI 답변을 비교하고 놓친 부분까지 교차검토하세요",
    description:
      "한 번 질문해 여러 AI 답변을 비교하고 AI Review로 합의점, 모순, 누락을 구조화하세요. 확인이 필요한 주장은 웹 검색과 Deep Research로 근거를 확인합니다.",
  },
  zh: {
    title: "比较多个 AI 回答并交叉审查遗漏",
    description:
      "一次向多个 AI 提问、比较回答，并用 AI Review 整理共识、矛盾与遗漏；需要核实的说法可用网页搜索和 Deep Research 查证。",
  },
  fr: {
    title: "Comparez les réponses IA et examinez leurs omissions",
    description:
      "Posez une question à plusieurs modèles, comparez leurs réponses et structurez accords, contradictions et omissions avec AI Review ; vérifiez le reste avec la recherche web et Deep Research.",
  },
  de: {
    title: "KI-Antworten vergleichen und Auslassungen gegenprüfen",
    description:
      "Fragen Sie mehrere KI-Modelle einmal, vergleichen Sie Antworten und ordnen Sie mit AI Review Gemeinsamkeiten, Widersprüche und Lücken – Prüfbedürftiges mit Websuche und Deep Research.",
  },
  es: {
    title: "Compara respuestas de IA y revisa lo que dejaron fuera",
    description:
      "Pregunta una vez a varios modelos, compara sus respuestas y organiza acuerdos, contradicciones y omisiones con AI Review; comprueba lo pendiente con búsqueda web y Deep Research.",
  },
  pt: {
    title: "Compare respostas de IA e revise o que ficou de fora",
    description:
      "Pergunte uma vez a vários modelos, compare respostas e organize consensos, contradições e omissões com o AI Review; confira o que falta com busca na web e Deep Research.",
  },
};

export const reviewOgCopy: Record<
  Language,
  { title: string; description: string }
> = {
  en: {
    title: "Tomverse Review | Multi-AI Comparison & Review",
    description:
      "The same question can produce different answers. In Tomverse Review, read up to three model answers side by side and use AI Review to examine agreements, differences and missing conditions with quotes. Decide which answer to explore and what to ask next.",
  },
  ko: {
    title: "Tomverse Review | 멀티 AI 비교 및 검토",
    description:
      "같은 질문에도 답변은 달라집니다. Tomverse Review에서 최대 3개 모델의 답변을 나란히 읽고, AI Review로 공통점·차이·빠진 조건을 인용과 함께 살펴보세요. 검토 결과를 바탕으로 더 읽을 답변과 다음 질문을 직접 고를 수 있습니다.",
  },
  zh: {
    title: "Tomverse Review | 多 AI 比较与审查",
    description:
      "同一个问题，可能得到不同回答。在 Tomverse Review 中并排阅读最多三个模型的回答，再用 AI Review 结合引文查看共识、差异与遗漏条件。由你决定重点阅读哪个回答、接下来问什么。",
  },
  fr: {
    title: "Tomverse Review | Comparaison et revue multi-IA",
    description:
      "Une même question peut produire des réponses différentes. Dans Tomverse Review, lisez jusqu’à trois réponses côte à côte et examinez avec AI Review leurs accords, différences et conditions oubliées, citations à l’appui. Choisissez ensuite quoi approfondir et quelle question poser.",
  },
  de: {
    title: "Tomverse Review | Multi-KI-Vergleich und -Prüfung",
    description:
      "Dieselbe Frage kann unterschiedliche Antworten liefern. Lesen Sie in Tomverse Review bis zu drei Modellantworten nebeneinander und prüfen Sie mit AI Review Gemeinsamkeiten, Unterschiede und fehlende Bedingungen samt Zitaten. Entscheiden Sie selbst, was Sie vertiefen und als Nächstes fragen.",
  },
  es: {
    title: "Tomverse Review | Comparación y revisión multi-IA",
    description:
      "La misma pregunta puede dar respuestas diferentes. En Tomverse Review, lee hasta tres respuestas en paralelo y usa AI Review para examinar coincidencias, diferencias y condiciones omitidas, con citas. Decide qué respuesta explorar y qué preguntar después.",
  },
  pt: {
    title: "Tomverse Review | Comparação e revisão multi-IA",
    description:
      "A mesma pergunta pode gerar respostas diferentes. No Tomverse Review, leia até três respostas lado a lado e use o AI Review para examinar consensos, diferenças e condições omitidas, com citações. Decida qual resposta explorar e o que perguntar depois.",
  },
};

export const homeSeoCopy: Record<Language, { title: string; description: string }> = {
  en: {
    title: "Which AI should you use? | Tomverse Chat & Review",
    description: "Use GPT, Claude and Gemini in one place. Smart Adaptive helps with model selection by capabilities, cost and quality; you decide on question suggestions. Compare answer differences and omissions with quotes in Review. Try Chat and Review as a guest.",
  },
  ko: {
    title: "어떤 AI를 쓸지, 고민은 Tomverse에. | Chat & Review",
    description: "GPT, Claude, Gemini를 한곳에서. Chat의 Smart Adaptive로 기능·비용·품질을 고려한 모델 선택을 돕고 질문 제안은 직접 채택하세요. Review에서 답변의 차이·누락을 인용으로 비교하세요. Chat과 Review 모두 비회원으로 시작할 수 있습니다.",
  },
  zh: {
    title: "该用哪个 AI，让 Tomverse 帮你选。| Chat & Review",
    description: "在一个地方使用GPT、Claude和Gemini。Smart Adaptive结合功能、费用与质量帮助选模型，提问建议由你决定是否采用。Review结合引文比较差异与遗漏。Chat和Review均可访客体验。",
  },
  fr: {
    title: "Quelle IA choisir ? | Tomverse Chat & Review",
    description: "Retrouvez GPT, Claude et Gemini au même endroit. Smart Adaptive aide à choisir selon les fonctions, le coût et la qualité ; vous décidez des reformulations. Comparez différences et omissions avec citations dans Review. Essayez Chat et Review sans compte.",
  },
  de: {
    title: "Welche KI passt zu Ihrer Frage? | Tomverse Chat & Review",
    description: "Nutzen Sie GPT, Claude und Gemini an einem Ort. Smart Adaptive unterstützt die Wahl nach Funktionen, Kosten und Qualität; Fragenvorschläge übernehmen Sie selbst. Vergleichen Sie Unterschiede und Lücken mit Zitaten in Review. Testen Sie Chat und Review als Gast.",
  },
  es: {
    title: "¿Qué IA elegir? | Tomverse Chat & Review",
    description: "Usa GPT, Claude y Gemini en un lugar. Smart Adaptive ayuda a elegir según funciones, coste y calidad; tú decides si aplicar las sugerencias. Compara diferencias y omisiones con citas en Review. Prueba Chat y Review como invitado.",
  },
  pt: {
    title: "Qual IA escolher? | Tomverse Chat & Review",
    description: "Use GPT, Claude e Gemini em um só lugar. O Smart Adaptive ajuda na escolha por recursos, custo e qualidade; você decide sobre as sugestões. Compare diferenças e lacunas com citações no Review. Experimente Chat e Review como visitante.",
  },
};

export const homeOgCopy: Record<Language, { title: string; description: string }> = Object.fromEntries(
  SEO_LOCALES.map((locale) => [locale, {
    title: homeSeoCopy[locale].title,
    description: homeSeoCopy[locale].description,
  }]),
) as Record<Language, { title: string; description: string }>;

const homeReviewEntryDescription: Record<Language, string> = {
  en: "Use GPT, Claude and Gemini in one place. Explore Smart Adaptive model selection and question suggestions you control in Chat; compare answer differences and omissions with quotes in Review. Try Review as a guest; Chat access depends on availability.",
  ko: "GPT, Claude, Gemini를 한곳에서. Chat의 Smart Adaptive 모델 선택과 직접 확인하는 질문 제안을 알아보고, Review에서 답변의 차이·누락을 인용으로 비교하세요. Review는 비회원으로 체험할 수 있고 Chat은 현재 제공 범위에 따라 이용합니다.",
  zh: "在一个地方使用GPT、Claude和Gemini。了解Chat的Smart Adaptive模型选择与由你决定的提问建议，在Review中结合引文比较差异与遗漏。Review可访客体验，Chat使用取决于当前提供范围。",
  fr: "Retrouvez GPT, Claude et Gemini au même endroit. Découvrez le choix Smart Adaptive et les reformulations que vous contrôlez dans Chat ; comparez différences et omissions avec citations dans Review. Review est accessible sans compte ; l’accès à Chat dépend de sa disponibilité.",
  de: "Nutzen Sie GPT, Claude und Gemini an einem Ort. Entdecken Sie Smart Adaptive und Fragenvorschläge unter Ihrer Kontrolle in Chat; vergleichen Sie Unterschiede und Lücken mit Zitaten in Review. Review ist ohne Konto testbar; Chat hängt von der Verfügbarkeit ab.",
  es: "Usa GPT, Claude y Gemini en un lugar. Conoce Smart Adaptive y las sugerencias que tú controlas en Chat; compara diferencias y omisiones con citas en Review. Prueba Review como invitado; el acceso a Chat depende de su disponibilidad.",
  pt: "Use GPT, Claude e Gemini em um só lugar. Conheça o Smart Adaptive e sugestões que você controla no Chat; compare diferenças e lacunas com citações no Review. Experimente o Review como visitante; o acesso ao Chat depende da disponibilidade.",
};

/** Static metadata uses only the public guest offer, never account capability. */
export const getHomeSeoCopy = (locale: Language, guestChatTrialAvailable: boolean) => ({
  title: homeSeoCopy[locale].title,
  description: guestChatTrialAvailable ? homeSeoCopy[locale].description : homeReviewEntryDescription[locale],
});

export const getHomeOgCopy = getHomeSeoCopy;
