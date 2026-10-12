import { headers } from "next/headers";
import { MarketingShell } from "@/components/marketing/MarketingShell";
import { DOCUMENT_LANGUAGE_HEADER, DOCUMENT_LANGUAGE_SOURCE_HEADER, isSupportedDocumentLanguage } from "@/lib/documentLanguage";

/** Request-time public guides share the chrome without a force-static parent. */
export const dynamic = "force-dynamic";

export default async function PublicGuidesLayout({ children }: Readonly<{
  children: React.ReactNode;
}>) {
  const requestHeaders = await headers();
  const documentLanguage = requestHeaders.get(DOCUMENT_LANGUAGE_HEADER);
  const lang = isSupportedDocumentLanguage(documentLanguage) ? documentLanguage : "en";
  const nonce = requestHeaders.get("x-nonce") || undefined;
  const forceInitialLang = requestHeaders.get(DOCUMENT_LANGUAGE_SOURCE_HEADER) === "search";
  return <MarketingShell initialLang={lang} forceInitialLang={forceInitialLang} nonce={nonce}>{children}</MarketingShell>;
}
