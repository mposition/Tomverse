import type { Language } from "@/components/LanguageProvider";
import { CHAT_WORKSPACE_PATH, PRODUCT_SURFACE_PATH } from "@/lib/productSurfaceRoutes";
import { localizedPath } from "@/lib/seo";

/** Product information and workspace entry remain distinct during cutover. */
export const homepageProductLinks = (lang: Language) => ({
  chatHref: `${CHAT_WORKSPACE_PATH}?lang=${encodeURIComponent(lang)}`,
  reviewHref: `${PRODUCT_SURFACE_PATH.review}?lang=${encodeURIComponent(lang)}`,
  reviewInfoHref: localizedPath(lang, "/products/review"),
});
