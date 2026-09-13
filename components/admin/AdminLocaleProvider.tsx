"use client";

import { useRouter } from "next/navigation";
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
  type AdminLocale,
  type AdminMessageCatalog,
  type AdminMessageShape,
} from "@/lib/adminLocale";

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

/** The cookies the server's locale resolution reads. */
const LOCALE_COOKIE_NAMES = [ADMIN_LOCALE_COOKIE, "tomverse_lang"];

const localeCookieSnapshot = () =>
  document.cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => LOCALE_COOKIE_NAMES.some((name) => part.startsWith(`${name}=`)))
    .sort()
    .join(";");

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
 * A layout is not re-rendered by client navigation, so a cookie changed in
 * another tab would leave this shell on the old language while the next page's
 * server components read the new one. When the tab regains focus and the
 * locale cookies differ from what this render was made with, it refreshes.
 */
export function AdminLocaleProvider({
  locale,
  children,
}: {
  locale: AdminLocale;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const renderedCookies = useRef<string | null>(null);

  useEffect(() => {
    // Recorded after every server render of this provider, so the comparison
    // is always against the cookies the current `locale` came from.
    renderedCookies.current = localeCookieSnapshot();
  }, [locale]);

  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== "visible") return;
      if (renderedCookies.current === null) return;
      if (localeCookieSnapshot() === renderedCookies.current) return;
      renderedCookies.current = localeCookieSnapshot();
      startTransition(() => router.refresh());
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [router]);

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
