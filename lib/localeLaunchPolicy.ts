import type { Language } from "@/components/LanguageProvider";

export type LocaleMarketTier = "primary" | "limited" | "preview";

type LocaleLaunchPolicy = {
  marketTier: LocaleMarketTier;
  paidMarketingEligible: boolean;
  selectorLabel: string;
  badge: string;
  scopeNotice: string | null;
  englishFallbackNotice: string | null;
};

export const PAID_MARKETING_LOCALES: readonly Language[] = ["en", "ko"];

export const localeLaunchPolicy = {
  en: {
    marketTier: "primary",
    paidMarketingEligible: true,
    selectorLabel: "English",
    badge: "Full support",
    scopeNotice: null,
    englishFallbackNotice: null,
  },
  ko: {
    marketTier: "primary",
    paidMarketingEligible: true,
    selectorLabel: "한국어",
    badge: "전체 지원",
    scopeNotice: null,
    englishFallbackNotice: null,
  },
  zh: {
    marketTier: "limited",
    paidMarketingEligible: false,
    selectorLabel: "中文 · 有限支持",
    badge: "中文有限支持",
    scopeNotice:
      "中文目前涵盖产品界面、价格、核心比较内容以及已翻译的法律和帮助页面。客户支持仅提供书面渠道，回复可能使用英语，暂不提供电话支持。",
    englishFallbackNotice:
      "此页面尚无经过审核的中文版本，因此当前显示英文内容。完整支持请使用 English 或 한국어。",
  },
  fr: {
    marketTier: "preview",
    paidMarketingEligible: false,
    selectorLabel: "Français · Aperçu",
    badge: "Aperçu linguistique",
    scopeNotice:
      "Le français est disponible en aperçu pour l’interface produit et les guides principaux. Les contenus juridiques, de facturation et d’assistance ne sont pas encore tous relus; utilisez English ou 한국어 pour une couverture complète.",
    englishFallbackNotice:
      "Cette page ne dispose pas encore d’une version française relue et s’affiche donc en anglais. Utilisez English ou 한국어 pour une couverture complète.",
  },
  de: {
    marketTier: "preview",
    paidMarketingEligible: false,
    selectorLabel: "Deutsch · Vorschau",
    badge: "Sprachvorschau",
    scopeNotice:
      "Deutsch ist als Vorschau für die Produktoberfläche und zentrale Leitfäden verfügbar. Rechtliche, Abrechnungs- und Supportinhalte sind noch nicht vollständig geprüft; für vollständige Unterstützung verwenden Sie English oder 한국어.",
    englishFallbackNotice:
      "Für diese Seite gibt es noch keine geprüfte deutsche Fassung, daher wird sie auf Englisch angezeigt. Vollständige Unterstützung erhalten Sie auf English oder 한국어.",
  },
  es: {
    marketTier: "preview",
    paidMarketingEligible: false,
    selectorLabel: "Español · Vista previa",
    badge: "Vista previa de idioma",
    scopeNotice:
      "El español está disponible como vista previa para la interfaz y las guías principales. El contenido legal, de facturación y soporte aún no está completamente revisado; usa English o 한국어 para obtener cobertura completa.",
    englishFallbackNotice:
      "Esta página aún no tiene una versión revisada en español, por lo que se muestra en inglés. Usa English o 한국어 para obtener cobertura completa.",
  },
  pt: {
    marketTier: "preview",
    paidMarketingEligible: false,
    selectorLabel: "Português · Prévia",
    badge: "Prévia de idioma",
    scopeNotice:
      "O português está disponível como prévia para a interface e os guias principais. O conteúdo jurídico, de faturação e de suporte ainda não foi totalmente revisto; use English ou 한국어 para cobertura completa.",
    englishFallbackNotice:
      "Esta página ainda não possui uma versão revista em português e, por isso, é apresentada em inglês. Use English ou 한국어 para cobertura completa.",
  },
} satisfies Record<Language, LocaleLaunchPolicy>;

export const getLocaleLaunchPolicy = (language: Language) =>
  localeLaunchPolicy[language];

export const localeMarketingAnalyticsProperties = (language: Language) => {
  const policy = getLocaleLaunchPolicy(language);
  return {
    market_tier: policy.marketTier,
    paid_marketing_eligible: policy.paidMarketingEligible,
  } as const;
};
