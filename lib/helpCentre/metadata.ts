import type { Metadata } from "next";
import type { Language } from "@/lib/language";
import { createPageMetadata, queryLanguageAlternates } from "@/lib/seo";
import { helpCentreCopy } from "./copy";
import { helpGuidePath } from "./links";

/*
 * The hub's metadata is lib/publicMarketingMetadata.ts ("/support/help-centre"),
 * like every prerendered localised marketing page. Guides are request-time
 * pages with `?lang=` URLs, so they build their own here.
 */
export function helpGuideMetadata(lang: Language, guideId: string): Metadata {
  const copy = helpCentreCopy(lang);
  const words = copy.guides[guideId];
  const basePath = helpGuidePath(guideId);
  const metadata = createPageMetadata({
    title: `${words.title} | ${copy.ui.breadcrumbHome} | Tomverse`,
    description: words.summary,
    path: `${basePath}?lang=${lang}`,
    locale: lang,
    absoluteTitle: true,
  });
  return { ...metadata, alternates: { ...metadata.alternates, languages: queryLanguageAlternates(basePath) } };
}
