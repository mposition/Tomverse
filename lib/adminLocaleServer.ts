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
} from "@/lib/documentLanguage";

/** The product's language cookie, written by `LanguageProvider`. */
const PRODUCT_LANGUAGE_COOKIE = "tomverse_lang";

/**
 * The console locale for the current request, for server components.
 *
 * The layout calls this once and hands the answer to the client shell, and a
 * page or server component that renders copy of its own calls it again: both
 * read the same request, so they cannot disagree.
 */
export async function getAdminLocale(): Promise<AdminLocale> {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  return resolveAdminLocale({
    adminCookie: cookieStore.get(ADMIN_LOCALE_COOKIE)?.value,
    productCookie: cookieStore.get(PRODUCT_LANGUAGE_COOKIE)?.value,
    documentLanguage: requestHeaders.get(DOCUMENT_LANGUAGE_HEADER),
    documentLanguageSource: requestHeaders.get(DOCUMENT_LANGUAGE_SOURCE_HEADER),
  });
}

export async function getAdminMessages<T>(
  catalog: AdminMessageCatalog<T>
): Promise<AdminMessageShape<T>> {
  return adminMessagesFor(catalog, await getAdminLocale());
}
