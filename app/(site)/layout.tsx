import { headers } from "next/headers";
import "../globals.css";
import { DocumentShell } from "@/components/DocumentShell";
import {
  DOCUMENT_LANGUAGE_HEADER,
  isSupportedDocumentLanguage,
} from "@/lib/documentLanguage";
import { rootMetadata, rootViewport } from "@/lib/rootMetadata";

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
  const documentLanguage = (await headers()).get(DOCUMENT_LANGUAGE_HEADER);
  const lang = isSupportedDocumentLanguage(documentLanguage)
    ? documentLanguage
    : "en";
  // UI-001. The theme bootstrap is an inline script, so under a strict CSP it
  // needs the request's nonce. Like the document language above, this is
  // infrastructure the proxy resolved for the request -- not per-user state --
  // and it is absent on the prerendered routes under this root, where
  // lib/staticMarketingCsp.ts hashes the built HTML instead.
  const nonce = (await headers()).get("x-nonce") || undefined;

  return (
    <DocumentShell lang={lang} nonce={nonce}>
      {children}
    </DocumentShell>
  );
}
