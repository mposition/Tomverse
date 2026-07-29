import { headers } from "next/headers";
import "../globals.css";
import { DocumentShell } from "@/components/DocumentShell";
import {
  DOCUMENT_LANGUAGE_HEADER,
  isSupportedDocumentLanguage,
} from "@/lib/documentLanguage";
import { rootMetadata } from "@/lib/rootMetadata";

export const metadata = rootMetadata;

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

  return <DocumentShell lang={lang}>{children}</DocumentShell>;
}
