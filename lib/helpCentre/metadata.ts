import type { Metadata } from "next";
import type { Language } from "@/lib/language";
import { createPageMetadata, localizedPath, queryLanguageAlternates } from "@/lib/seo";
import { helpCentreCopy } from "./copy";
import { HELP_HUB_PATH, helpGuidePath } from "./links";

export function helpHubMetadata(lang: Language, localizedRoute: boolean): Metadata {
  const ui = helpCentreCopy(lang).ui;
  return createPageMetadata({
    title: ui.metaTitle,
    description: ui.metaDescription,
    path: localizedRoute ? localizedPath(lang, HELP_HUB_PATH) : HELP_HUB_PATH,
    locale: lang,
    localizedBasePath: HELP_HUB_PATH,
    absoluteTitle: true,
  });
}

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
