import type { Language } from "@/components/LanguageProvider";
import type { MarketingInfoCopy } from "@/components/marketing/MarketingInfoPage";

const SECTION_NAV_LABELS: Partial<Record<Language, string>> = {
  en: "Jump to a section",
  ko: "조항 바로가기",
  zh: "跳转到条款",
};

/**
 * Adds a collapsible jump-to-section list to a long legal page. The copy itself
 * is left untouched (its digest is a publication record), so the anchors and
 * label are derived here at render time.
 */
export function withLegalSectionNav<T extends { en: MarketingInfoCopy } & Partial<Record<Language, MarketingInfoCopy>>>(content: T): T {
  const result: Partial<Record<Language, MarketingInfoCopy>> = {};
  for (const [lang, copy] of Object.entries(content) as [Language, MarketingInfoCopy][]) {
    result[lang] = {
      ...copy,
      sectionNavLabel: copy.sectionNavLabel ?? SECTION_NAV_LABELS[lang] ?? SECTION_NAV_LABELS.en,
      sectionNavCollapsible: true,
      sections: copy.sections.map((section, index) => ({ ...section, id: section.id ?? `section-${index + 1}` })),
    };
  }
  return result as T;
}
