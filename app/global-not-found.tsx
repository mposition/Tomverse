import { headers } from "next/headers";
import "./globals.css";
import { DocumentShell } from "@/components/DocumentShell";
import { NotFoundContent } from "@/components/NotFoundContent";
import {
  DOCUMENT_LANGUAGE_HEADER,
  isSupportedDocumentLanguage,
} from "@/lib/documentLanguage";
import { rootMetadata, rootViewport } from "@/lib/rootMetadata";
import { isThemePreference, THEME_HEADER } from "@/lib/theme";

export const metadata = { ...rootMetadata, title: "Page not found" };
export const viewport = rootViewport;

/**
 * The 404 for a URL that matches no route at all.
 *
 * This app has two root layouts -- `app/(site)/layout.tsx` and
 * `app/[locale]/layout.tsx`, because `<html lang>` has two correct sources
 * (components/DocumentShell.tsx). A request that matches neither has no route,
 * so Next has no root layout to compose `app/not-found.tsx` with, and it
 * refused the whole response: `not-found.tsx doesn't have a root layout`,
 * logged on the server and answered with a 500. Every mistyped URL, every dead
 * link and every guessed path -- `/help` among them, which is what surfaced it
 * -- got "something went wrong" instead of "that page does not exist", with no
 * link to the help centre or support on it.
 *
 * `global-not-found.tsx` is the convention Next documents for exactly this
 * shape (multiple root layouts, or a root layout under a top-level dynamic
 * segment). It is handled at the routing level rather than by rendering a
 * layout, so it must render the whole document itself -- hence the stylesheet
 * import and `DocumentShell` here rather than above. It is enabled by
 * `experimental.globalNotFound` in next.config.ts; without that flag this file
 * is not read at all.
 *
 * The language, theme and nonce come from the proxy's request headers, the same
 * way `app/(site)/layout.tsx` reads them. Reading them keeps the response
 * per-request, which is what a 404 is anyway: there is nothing here to cache
 * publicly, and the account-switch recovery in NotFoundContent needs the
 * request path.
 */
export default async function GlobalNotFound() {
  const requestHeaders = await headers();
  const documentLanguage = requestHeaders.get(DOCUMENT_LANGUAGE_HEADER);
  const lang = isSupportedDocumentLanguage(documentLanguage)
    ? documentLanguage
    : "en";
  const themeHeader = requestHeaders.get(THEME_HEADER);
  const theme = isThemePreference(themeHeader) ? themeHeader : null;
  const nonce = requestHeaders.get("x-nonce") || undefined;

  return (
    <DocumentShell lang={lang} theme={theme} nonce={nonce}>
      <NotFoundContent />
    </DocumentShell>
  );
}
