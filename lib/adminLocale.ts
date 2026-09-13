import { resolveDocumentLanguage } from "@/lib/documentLanguage";
import { isLanguage } from "@/lib/language";

/**
 * The languages the Admin Console is written in, and how one is chosen.
 *
 * Contract: docs/ui-contracts/admin-console-ia.md, "Language".
 *
 * Deliberately two, not the product's seven. The console is an internal tool
 * read by the people who run Tomverse, and a half-translated console is worse
 * than an English one: an operator acting on a refund or a kill switch has to
 * be able to trust that every label on the screen says the same thing in the
 * same language. Anything that is not Korean therefore reads English, including
 * a customer-facing locale such as French that the console has no copy for.
 *
 * Framework-free on purpose. The server layout resolves the locale once, from
 * the request, and hands it to the client shell; plain Node tests import the
 * same resolver.
 */

export const ADMIN_LOCALES = ["en", "ko"] as const;

export type AdminLocale = (typeof ADMIN_LOCALES)[number];

export const DEFAULT_ADMIN_LOCALE: AdminLocale = "en";

/**
 * The console's own language choice.
 *
 * Separate from the product's `tomverse_lang`: the console has two languages
 * and the product has seven, so writing the console's choice into the product
 * cookie would move an operator's customer-facing language as a side effect of
 * reading an admin page -- and a French product choice has no admin meaning at
 * all. Functional only, like `tomverse_lang`; it is not read by analytics.
 */
export const ADMIN_LOCALE_COOKIE = "tomverse_admin_lang";
export const ADMIN_LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const isAdminLocale = (value: unknown): value is AdminLocale =>
  typeof value === "string" && (ADMIN_LOCALES as readonly string[]).includes(value);

const fromProductLanguage = (value: unknown): AdminLocale | null =>
  isLanguage(value) ? (value === "ko" ? "ko" : "en") : null;

/**
 * The locale a console request renders in.
 *
 * Most specific first:
 *
 * 1. the console's own cookie -- the operator picked a console language;
 * 2. the product language cookie -- the operator picked a product language,
 *    and Korean there means Korean here;
 * 3. the browser's `Accept-Language`.
 *
 * Every step maps onto the two console languages, and anything unrecognised
 * falls through to the next step rather than to English, so a malformed cookie
 * cannot override the browser's preference.
 *
 * The product's `?lang=` pin (VAL-003) is deliberately not an input. The
 * console has its own switch, and a query value is per-URL: the shell is
 * rendered by a layout that survives client navigation, so a locale taken from
 * one page's query would stay on screen beside the next page's server
 * components rendered without it, and router prefetches never pass through the
 * proxy step that reads it. Inputs that are the same for every request in a
 * session -- two cookies and a request header -- cannot disagree that way.
 */
export const resolveAdminLocale = ({
  adminCookie,
  productCookie,
  acceptLanguage,
}: {
  adminCookie?: string | null;
  productCookie?: string | null;
  acceptLanguage?: string | null;
}): AdminLocale =>
  (isAdminLocale(adminCookie) ? adminCookie : null) ||
  fromProductLanguage(productCookie) ||
  fromProductLanguage(
    acceptLanguage
      ? resolveDocumentLanguage({ acceptLanguage }).language
      : null
  ) ||
  DEFAULT_ADMIN_LOCALE;

/** The BCP 47 tag for `Intl` formatting in a given console locale. */
export const adminIntlLocale = (locale: AdminLocale) =>
  locale === "ko" ? "ko-KR" : "en-US";

/**
 * The shape a Korean dictionary must have, derived from the English one.
 *
 * Strings stay strings, formatters keep their exact parameter list, and nested
 * groups recurse. A key missing from Korean, an extra key, or a formatter that
 * takes different arguments is a type error -- which is what lets a panel be
 * translated without a runtime check that a label exists.
 */
export type AdminMessageShape<T> = {
  readonly [K in keyof T]: T[K] extends string
    ? string
    : T[K] extends (...args: infer A) => infer R
      ? (...args: A) => R
      : T[K] extends object
        ? AdminMessageShape<T[K]>
        : T[K];
};

export type AdminMessageCatalog<T> = {
  readonly en: T;
  readonly ko: AdminMessageShape<T>;
};

/**
 * Declares one namespace of console copy in both languages.
 *
 * English is the source of truth for the shape; Korean is checked against it.
 * An identity function at runtime -- the value is in the type parameter.
 */
export const defineAdminMessages = <T extends object>(catalog: {
  en: T;
  ko: AdminMessageShape<T>;
}): AdminMessageCatalog<T> => catalog;

/** The dictionary for one locale. Korean satisfies the English shape. */
export const adminMessagesFor = <T>(
  catalog: AdminMessageCatalog<T>,
  locale: AdminLocale
): AdminMessageShape<T> =>
  // English is the shape by definition; TypeScript cannot see that a mapped
  // type over T accepts T itself when T is still generic.
  locale === "ko" ? catalog.ko : (catalog.en as unknown as AdminMessageShape<T>);
