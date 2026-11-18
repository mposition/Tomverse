import type { Language } from "@/lib/language";
import { marketingProductEntryHref } from "@/lib/marketingProductEntry";
import { settingsSectionHref } from "@/lib/settingsNavigation";
import { localizedPath } from "@/lib/seo";
import type { HelpGuideAction } from "./types";

export const HELP_HUB_PATH = "/support/help-centre";
export const helpGuidePath = (guideId: string) => `${HELP_HUB_PATH}/guides/${guideId}`;

/**
 * The hub is a prerendered localised route (`/ko/support/help-centre`). Guide
 * pages are request-time public guides like `/guides/assistant-knowledge`, so
 * they take the language as `?lang=` -- a new localised path would have to be
 * registered in lib/marketingRoutes.ts, which is pinned by the Prompt
 * Refiner's runtime source closure.
 */
export const helpHubHref = (lang: Language) => localizedPath(lang, HELP_HUB_PATH);
export const helpGuideHref = (lang: Language, guideId: string, step?: number) =>
  `${helpGuidePath(guideId)}?lang=${encodeURIComponent(lang)}${step ? `#step-${step}` : ""}`;

const withLang = (href: string, lang: Language) => {
  const url = new URL(href, "https://tomverse.app");
  url.searchParams.set("lang", lang);
  return `${url.pathname}${url.search}${url.hash}`;
};

/** The URL a guide's "try it" button opens. */
export function helpActionHref(action: HelpGuideAction, lang: Language): string {
  switch (action.kind) {
    case "product":
      return marketingProductEntryHref(action.product, lang);
    case "settings":
      return withLang(settingsSectionHref(action.section), lang);
    case "settings-tab":
      return withLang(`/review?settings=${action.tab}`, lang);
    case "public":
      return action.path === "/support" || action.path === "/pricing" || action.path === "/refund" || action.path === "/privacy"
        ? localizedPath(lang, action.path)
        : withLang(action.path, lang);
  }
}
