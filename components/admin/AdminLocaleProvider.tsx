"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
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
  setLocale: (next: AdminLocale) => void;
};

const AdminLocaleContext = createContext<AdminLocaleContextValue>({
  locale: DEFAULT_ADMIN_LOCALE,
  setLocale: () => {},
});

/**
 * The console's language, as the server resolved it for this request.
 *
 * The value is a prop, not something read in the browser after mount. The
 * product's `LanguageProvider` restores a saved language in an effect, which is
 * fine for a page that renders entirely on the client -- but the console also
 * renders copy in server components (page tabs, page headings), and a client
 * that switched language after hydration would leave those in the other
 * language beside it.
 *
 * Changing language writes the console cookie and refreshes the route, so the
 * server re-renders every server component in the new language. The chosen
 * locale is applied to client components immediately rather than after the
 * refresh lands, so the control the operator just pressed answers at once.
 */
export function AdminLocaleProvider({
  locale: serverLocale,
  children,
}: {
  locale: AdminLocale;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<AdminLocale | null>(null);
  const locale = chosen ?? serverLocale;

  const setLocale = useCallback(
    (next: AdminLocale) => {
      setChosen(next);
      document.cookie =
        `${ADMIN_LOCALE_COOKIE}=${next}; path=/; max-age=${ADMIN_LOCALE_COOKIE_MAX_AGE}; samesite=lax` +
        (window.location.protocol === "https:" ? "; secure" : "");
      router.refresh();
    },
    [router]
  );

  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);

  return (
    <AdminLocaleContext.Provider value={value}>
      {/*
        `lang` on the console's own root, not on <html>: the document element
        belongs to the product's language, and `:lang()` selects the Korean
        typeface for this subtree (docs/ui-contracts/typography.md). It is
        `display: contents` so it adds no box to the shell's layout.
      */}
      <div lang={locale} className="contents">
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
