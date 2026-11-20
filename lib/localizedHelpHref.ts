import type { Language } from "@/components/LanguageProvider";

/** Where the guides live. `/help` is redirected here by next.config.ts. */
export const HELP_CENTRE_PATH = "/support/help-centre";

/**
 * The help centre hub in the reader's language. The old Chat workspace guide
 * (`/support/help-centre/chat-workspace`) was folded into the hub and now
 * redirects there, so every "learn more" link points at the hub directly.
 */
export const helpCentreHref = (lang: Language) => {
  const url = new URL(HELP_CENTRE_PATH, "https://tomverse.app");
  url.searchParams.set("lang", lang);
  return `${url.pathname}${url.search}`;
};

