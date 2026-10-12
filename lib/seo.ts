import type { Metadata } from "next";
import type { Language } from "@/components/LanguageProvider";

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

export const LOCALIZED_SEO_PATHS = [
  "/",
  "/compare-ai-models",
  "/ai-answer-review",
  "/chatgpt-vs-claude",
  "/ai-for-file-analysis",
  "/products/review",
] as const;

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
  ogTitle?: string;
  ogDescription?: string;
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
        alt: "Tomverse — Chat and Review with GPT, Claude, and Gemini in one place",
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
        alt: "Tomverse — Chat and Review with GPT, Claude, and Gemini in one place",
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
    title: "Tomverse | Multi-AI Comparison & Review",
    description:
      "Compare GPT, Claude, and Gemini side by side, use AI Review to identify differences and omissions, then check the points that need verification.",
  },
  ko: {
    title: "Tomverse | 멀티 AI 비교 및 검토",
    description:
      "GPT, Claude, Gemini의 답변을 나란히 비교하고 AI Review로 차이점과 누락을 확인한 뒤, 검증이 필요한 부분은 웹 검색으로 확인하세요.",
  },
  zh: {
    title: "Tomverse | 多 AI 比较与审查",
    description:
      "并排比较 GPT、Claude 和 Gemini 的回答，用 AI Review 找出差异与遗漏，再核实需要查证的要点。",
  },
  fr: {
    title: "Tomverse | Comparaison et revue multi-IA",
    description:
      "Comparez GPT, Claude et Gemini côte à côte, repérez différences et omissions avec AI Review, puis vérifiez les points qui le demandent.",
  },
  de: {
    title: "Tomverse | Multi-KI-Vergleich und -Prüfung",
    description:
      "Vergleichen Sie GPT, Claude und Gemini nebeneinander, erkennen Sie mit AI Review Unterschiede und Lücken und prüfen Sie danach, was geprüft werden muss.",
  },
  es: {
    title: "Tomverse | Comparación y revisión multi-IA",
    description:
      "Compara GPT, Claude y Gemini en paralelo, identifica diferencias y omisiones con AI Review y después comprueba los puntos que lo requieran.",
  },
  pt: {
    title: "Tomverse | Comparação e revisão multi-IA",
    description:
      "Compare GPT, Claude e Gemini lado a lado, identifique diferenças e omissões com o AI Review e depois confira os pontos que precisam de verificação.",
  },
};

export const homeSeoCopy: Record<Language, { title: string; description: string }> = {
  en: {
    title: "Several AIs. One Place. | Tomverse Chat & Review",
    description: "Use GPT, Claude and Gemini in Tomverse. Chat with Smart Adaptive to consider model cost and quality, then compare different perspectives with Review. Start both as a guest.",
  },
  ko: {
    title: "여러 AI를 한곳에서 | Tomverse Chat & Review",
    description: "GPT, Claude, Gemini를 Tomverse 한곳에서 사용하세요. Chat의 Smart Adaptive로 모델 비용과 품질을 함께 고려하고, Review로 서로 다른 답변의 관점을 비교하세요. 두 제품 모두 비회원으로 시작할 수 있습니다.",
  },
  zh: {
    title: "多个 AI，同一个地方 | Tomverse Chat & Review",
    description: "在 Tomverse 使用 GPT、Claude 和 Gemini。Chat 的 Smart Adaptive 兼顾模型成本与质量，Review 帮助比较回答中的不同观点。两款产品均可访客体验。",
  },
  fr: {
    title: "Plusieurs IA au même endroit | Tomverse Chat & Review",
    description: "Utilisez GPT, Claude et Gemini dans Tomverse. Smart Adaptive tient compte du coût et de la qualité des modèles dans Chat ; Review compare les différents points de vue. Essayez les deux sans compte.",
  },
  de: {
    title: "Mehrere KIs an einem Ort | Tomverse Chat & Review",
    description: "Nutzen Sie GPT, Claude und Gemini in Tomverse. Smart Adaptive berücksichtigt Modellkosten und Qualität in Chat. Review vergleicht verschiedene Perspektiven. Beide Produkte lassen sich als Gast starten.",
  },
  es: {
    title: "Varias IA en un mismo lugar | Tomverse Chat & Review",
    description: "Usa GPT, Claude y Gemini en Tomverse. Smart Adaptive considera el coste y la calidad del modelo en Chat, y Review compara distintas perspectivas. Prueba ambos sin crear una cuenta.",
  },
  pt: {
    title: "Várias IAs em um só lugar | Tomverse Chat & Review",
    description: "Use GPT, Claude e Gemini no Tomverse. O Smart Adaptive considera custo e qualidade do modelo no Chat, e o Review compara diferentes perspectivas. Experimente ambos sem criar uma conta.",
  },
};

export const homeOgCopy: Record<Language, { title: string; description: string }> = Object.fromEntries(
  SEO_LOCALES.map((locale) => [locale, {
    title: homeSeoCopy[locale].title,
    description: homeSeoCopy[locale].description,
  }]),
) as Record<Language, { title: string; description: string }>;

const homeReviewEntryDescription: Record<Language, string> = {
  en: "Use multiple AI models in Tomverse. Explore Smart Adaptive's cost and quality-aware selection in Chat and compare different perspectives in Review. Try Review without an account; Chat access depends on availability.",
  ko: "여러 AI를 Tomverse 한곳에서 사용하세요. Chat의 Smart Adaptive는 모델 비용과 품질을 고려하고, Review는 서로 다른 답변의 관점을 비교합니다. Review는 비회원으로 체험할 수 있으며 Chat은 제공되는 환경에서 이용할 수 있습니다.",
  zh: "在 Tomverse 一个地方使用多个 AI。了解 Chat 中兼顾费用与质量的 Smart Adaptive，在 Review 中比较不同视角。Review 可访客体验，Chat 需视提供情况使用。",
  fr: "Utilisez plusieurs IA dans Tomverse. Découvrez Smart Adaptive dans Chat et comparez les points de vue dans Review. Essayez Review sans compte ; l’accès à Chat dépend de sa disponibilité.",
  de: "Nutzen Sie mehrere KIs in Tomverse. Entdecken Sie Smart Adaptive in Chat und vergleichen Sie Perspektiven in Review. Testen Sie Review ohne Konto; Chat-Zugang hängt von der Verfügbarkeit ab.",
  es: "Usa varias IA en Tomverse. Explora Smart Adaptive en Chat y compara perspectivas en Review. Prueba Review sin cuenta; el acceso a Chat depende de su disponibilidad.",
  pt: "Use várias IAs no Tomverse. Conheça o Smart Adaptive no Chat e compare perspectivas no Review. Experimente o Review sem conta; o acesso ao Chat depende da disponibilidade.",
};

/** Static metadata uses only the public guest offer, never account capability. */
export const getHomeSeoCopy = (locale: Language, guestChatTrialAvailable: boolean) => ({
  title: homeSeoCopy[locale].title,
  description: guestChatTrialAvailable ? homeSeoCopy[locale].description : homeReviewEntryDescription[locale],
});

export const getHomeOgCopy = getHomeSeoCopy;
