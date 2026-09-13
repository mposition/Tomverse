import { cookies, headers } from "next/headers";
import {
  ADMIN_LOCALE_COOKIE,
  adminMessagesFor,
  resolveAdminLocale,
  type AdminLocale,
  type AdminMessageCatalog,
  type AdminMessageShape,
} from "@/lib/adminLocale";
import {
  DOCUMENT_LANGUAGE_HEADER,
  DOCUMENT_LANGUAGE_SOURCE_HEADER,
  resolveDocumentLanguage,
} from "@/lib/documentLanguage";

/** The product's language cookie, written by `LanguageProvider`. */
const PRODUCT_LANGUAGE_COOKIE = "tomverse_lang";

/**
 * The console locale for the current request, for server components.
 *
 * The layout calls this once and hands the answer to the client shell, and a
 * page or server component that renders copy of its own calls it again. Within
 * one request both read the same cookies and headers. Across requests a layout
 * is not re-rendered by client navigation, so a cookie changed elsewhere could
 * let them diverge; `AdminLocaleProvider` refreshes the route when it notices.
 */
export async function getAdminLocale(): Promise<AdminLocale> {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  // The proxy returns early for router prefetches, before it sets the document
  // language headers. Without this fallback a prefetched page would resolve on
  // cookies alone and cache English for an operator whose browser asks for
  // Korean, while the layout that was rendered by a full request speaks Korean.
  const resolvedHeader = requestHeaders.get(DOCUMENT_LANGUAGE_HEADER);
  const requestDocument = resolvedHeader
    ? {
        language: resolvedHeader,
        source: requestHeaders.get(DOCUMENT_LANGUAGE_SOURCE_HEADER),
      }
    : resolveDocumentLanguage({
        acceptLanguage: requestHeaders.get("accept-language"),
      });
  return resolveAdminLocale({
    adminCookie: cookieStore.get(ADMIN_LOCALE_COOKIE)?.value,
    productCookie: cookieStore.get(PRODUCT_LANGUAGE_COOKIE)?.value,
    documentLanguage: requestDocument.language,
    documentLanguageSource: requestDocument.source,
  });
}

export async function getAdminMessages<T>(
  catalog: AdminMessageCatalog<T>
): Promise<AdminMessageShape<T>> {
  return adminMessagesFor(catalog, await getAdminLocale());
}
