"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useTransition,
} from "react";
import {
  ADMIN_LOCALE_COOKIE,
  ADMIN_LOCALE_COOKIE_MAX_AGE,
  DEFAULT_ADMIN_LOCALE,
  adminMessagesFor,
  isAdminLocale,
  type AdminLocale,
  type AdminMessageCatalog,
  type AdminMessageShape,
} from "@/lib/adminLocale";
import { isLanguage } from "@/lib/language";

type AdminLocaleContextValue = {
  locale: AdminLocale;
  /** True between choosing a language and the server re-render landing. */
  pending: boolean;
  setLocale: (next: AdminLocale) => void;
};

const AdminLocaleContext = createContext<AdminLocaleContextValue>({
  locale: DEFAULT_ADMIN_LOCALE,
  pending: false,
  setLocale: () => {},
});

const readCookie = (name: string) =>
  document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? null;

/**
 * The locale the server would resolve now, as far as the browser can tell.
 *
 * The same precedence as `resolveAdminLocale()` for the two inputs a browser
 * can read. The third, `Accept-Language`, is not visible here, so with neither
 * cookie set the answer is unknown and nothing is refreshed.
 */
const localeFromCookies = (): AdminLocale | null => {
  const consoleChoice = readCookie(ADMIN_LOCALE_COOKIE);
  if (isAdminLocale(consoleChoice)) return consoleChoice;
  const product = readCookie("tomverse_lang");
  return isLanguage(product) ? (product === "ko" ? "ko" : "en") : null;
};

/**
 * The console's language, exactly as the server resolved it for this render.
 *
 * The server value is the only value. The product's `LanguageProvider` restores
 * a saved language in an effect, which suits a page rendered entirely on the
 * client -- but the console also renders copy in server components (page tabs,
 * page panels), and any client-side guess would let the shell speak one
 * language while those speak another. So nothing here switches language
 * locally: choosing one writes the cookie and refreshes the route, and the new
 * value arrives as a prop with the server components that use it.
 *
 * A layout is not re-rendered by client navigation, so a locale cookie that
 * changes after this render would leave the shell on the old language while
 * the next page's server components read the new one. The cookie can change in
 * another tab, or in this one: the product's `LanguageProvider`, mounted above
 * the console, persists a restored or detected language to `tomverse_lang`
 * after hydration. So shortly after mount, after every navigation and whenever
 * the tab regains focus, the locale the cookies now imply is compared with the
 * one on screen, and a difference refreshes the route. A cookie rewritten with
 * the value it already implied -- the ordinary page load -- refreshes nothing.
 */
export function AdminLocaleProvider({
  locale,
  children,
}: {
  locale: AdminLocale;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  // The locale a refresh was last requested for, so a server that answers
  // differently from the cookies' implication is asked once, not in a loop.
  const requested = useRef<AdminLocale | null>(null);

  const refreshIfCookiesMoved = useCallback(() => {
    const implied = localeFromCookies();
    if (!implied || implied === locale || implied === requested.current) return;
    requested.current = implied;
    startTransition(() => router.refresh());
  }, [locale, router]);

  useEffect(() => {
    // A navigation discards a refresh still in flight, so a request made before
    // it may never have landed: each page gets to ask again, once.
    requested.current = null;
    // Deferred past `LanguageProvider`'s own zero-delay restore, which is the
    // write this is waiting for on first load.
    const timer = window.setTimeout(refreshIfCookiesMoved, 250);
    return () => window.clearTimeout(timer);
  }, [pathname, refreshIfCookiesMoved]);

  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === "visible") refreshIfCookiesMoved();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [refreshIfCookiesMoved]);

  const setLocale = useCallback(
    (next: AdminLocale) => {
      document.cookie =
        `${ADMIN_LOCALE_COOKIE}=${next}; path=/; max-age=${ADMIN_LOCALE_COOKIE_MAX_AGE}; samesite=lax` +
        (window.location.protocol === "https:" ? "; secure" : "");
      // Always refresh, even when `next` is the language on screen: it is also
      // how an operator recovers a shell that disagrees with its cookie.
      startTransition(() => router.refresh());
    },
    [router]
  );

  const value = useMemo(
    () => ({ locale, pending, setLocale }),
    [locale, pending, setLocale]
  );

  return (
    <AdminLocaleContext.Provider value={value}>
      {/*
        `lang` on the console's own root, not on <html>: the document element
        belongs to the product's language. `data-locale-root` makes the root
        re-resolve the typeface for its own language (app/globals.css,
        docs/ui-contracts/typography.md). `display: contents` adds no box to the
        shell's layout; `font-family` still inherits through it.
      */}
      <div lang={locale} data-locale-root="" className="contents">
        {children}
      </div>
    </AdminLocaleContext.Provider>
  );
}

export const useAdminLocale = () => useContext(AdminLocaleContext);

/** One namespace of console copy, in the console's current language. */
export function useAdminMessages<T>(
  catalog: AdminMessageCatalog<T>
): AdminMessageShape<T> {
  const { locale } = useAdminLocale();
  return adminMessagesFor(catalog, locale);
}
