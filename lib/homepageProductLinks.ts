import type { Language } from "@/components/LanguageProvider";
import { marketingProductEntryHref } from "@/lib/marketingProductEntry";
import { localizedPath } from "@/lib/seo";

/** Product information and workspace entry remain distinct during cutover. */
export const homepageProductLinks = (lang: Language) => ({
  chatHref: marketingProductEntryHref("chat", lang),
  reviewHref: marketingProductEntryHref("review", lang),
  reviewInfoHref: localizedPath(lang, "/products/review"),
});
