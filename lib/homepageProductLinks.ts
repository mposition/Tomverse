import type { Language } from "@/components/LanguageProvider";
import { localizedPath } from "@/lib/seo";

/** Product information and workspace entry remain distinct during cutover. */
export const homepageProductLinks = (lang: Language) => ({
  reviewInfoHref: localizedPath(lang, "/products/review"),
});
