/**
 * The language list, on its own, in a module with no `"use client"` boundary.
 *
 * `LanguageProvider` is a client component, so anything it exports can only be
 * rendered or passed as props -- a server component that tries to *call* one of
 * its functions fails at request time. Server routes that have to resolve a
 * locale before rendering (see app/(application)/auth/signin/page.tsx) need the
 * guard here instead, and keeping the list in one place is what stops the
 * server's idea of a supported language from drifting from the client's.
 */
export const SUPPORTED_LANGUAGES = ["ko", "en", "zh", "fr", "de", "es", "pt"] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const isLanguage = (value: unknown): value is Language =>
  typeof value === "string" && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
