import { headers } from "next/headers";
import "../globals.css";
import { DocumentShell } from "@/components/DocumentShell";
import {
  DOCUMENT_LANGUAGE_HEADER,
  isSupportedDocumentLanguage,
} from "@/lib/documentLanguage";
import { rootMetadata, rootViewport } from "@/lib/rootMetadata";
import { isThemePreference, THEME_HEADER } from "@/lib/theme";

export const metadata = rootMetadata;
export const viewport = rootViewport;

/**
 * Root layout for the English marketing pages and the application.
 *
 * The `(site)` group exists so these two keep sharing one root: a route group
 * does not appear in the URL, so `/pricing` and `/chat` are unchanged, and a
 * link between them is still a client navigation. Only `/{locale}` sits
 * outside it, under its own root -- see components/DocumentShell.tsx for why
 * the split is needed at all, and app/[locale]/layout.tsx for the other half.
 *
 * VAL-004. The proxy resolves the document language for the request. On a
 * statically prerendered route (every marketing page under this root) the
 * header is absent and "en" is the right answer: those pages are built once,
 * with English copy, and serve it to everyone.
 */
export default async function SiteLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const requestHeaders = await headers();
  const documentLanguage = requestHeaders.get(DOCUMENT_LANGUAGE_HEADER);
  const lang = isSupportedDocumentLanguage(documentLanguage)
    ? documentLanguage
    : "en";

  // UI-001. Both of these are absent on the statically prerendered marketing
  // routes under this root, and that absence is the correct answer rather than
  // a gap: their HTML is cached publicly, so it must not carry one visitor's
  // theme, and it is served under a hash-based CSP with no nonce. The
  // stylesheet's `prefers-color-scheme` covers the default there and
  // ThemeBootstrap corrects an explicit choice before the first paint.
  const themeHeader = requestHeaders.get(THEME_HEADER);
  const theme = isThemePreference(themeHeader) ? themeHeader : null;
  const nonce = requestHeaders.get("x-nonce") || undefined;

  return (
    <DocumentShell lang={lang} theme={theme} nonce={nonce}>
      {children}
    </DocumentShell>
  );
}
