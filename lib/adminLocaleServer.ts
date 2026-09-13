import { cookies, headers } from "next/headers";
import {
  ADMIN_LOCALE_COOKIE,
  adminMessagesFor,
  resolveAdminLocale,
  type AdminLocale,
  type AdminMessageCatalog,
  type AdminMessageShape,
} from "@/lib/adminLocale";

/** The product's language cookie, written by `LanguageProvider`. */
const PRODUCT_LANGUAGE_COOKIE = "tomverse_lang";

/**
 * The console locale for the current request, for server components.
 *
 * The layout calls this once and hands the answer to the client shell, and a
 * page or server component that renders copy of its own calls it again. Both
 * read the raw request -- two cookies and `Accept-Language` -- rather than the
 * proxy's resolved language headers, because router prefetches return from the
 * proxy before those are set. Across requests a layout is not re-rendered by
 * client navigation, so a cookie changed elsewhere could let the two diverge;
 * `AdminLocaleProvider` refreshes the route when it notices.
 */
export async function getAdminLocale(): Promise<AdminLocale> {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  return resolveAdminLocale({
    adminCookie: cookieStore.get(ADMIN_LOCALE_COOKIE)?.value,
    productCookie: cookieStore.get(PRODUCT_LANGUAGE_COOKIE)?.value,
    acceptLanguage: requestHeaders.get("accept-language"),
  });
}

export async function getAdminMessages<T>(
  catalog: AdminMessageCatalog<T>
): Promise<AdminMessageShape<T>> {
  return adminMessagesFor(catalog, await getAdminLocale());
}
