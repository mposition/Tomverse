import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { HelpGuidePage } from "@/components/help/HelpGuidePage";
import { LanguageProvider } from "@/components/LanguageProvider";
import { DOCUMENT_LANGUAGE_HEADER, isSupportedDocumentLanguage } from "@/lib/documentLanguage";
import { helpGuideMeta } from "@/lib/helpCentre/catalog";
import { helpCentreCopy } from "@/lib/helpCentre/copy";
import { helpGuideMetadata } from "@/lib/helpCentre/metadata";

// Request-time like /guides/assistant-knowledge: the language comes from
// `?lang=` (or the document-language header the proxy sets), and the page
// gets the per-request CSP nonce the public-guides layout reads.
export const dynamic = "force-dynamic";

type HelpGuideRouteProps = {
  params: Promise<{ guideId: string }>;
  searchParams: Promise<{ lang?: string | string[] }>;
};

async function guideLanguage(searchParams: HelpGuideRouteProps["searchParams"]) {
  const query = await searchParams;
  const requested = Array.isArray(query.lang) ? query.lang[0] : query.lang;
  if (isSupportedDocumentLanguage(requested)) return { lang: requested, explicit: true };
  const documentLanguage = (await headers()).get(DOCUMENT_LANGUAGE_HEADER);
  return { lang: isSupportedDocumentLanguage(documentLanguage) ? documentLanguage : ("en" as const), explicit: false };
}

export async function generateMetadata({ params, searchParams }: HelpGuideRouteProps): Promise<Metadata> {
  const { guideId } = await params;
  if (!helpGuideMeta(guideId)) return {};
  const { lang } = await guideLanguage(searchParams);
  return helpGuideMetadata(lang, guideId);
}

export default async function HelpGuideRoute({ params, searchParams }: HelpGuideRouteProps) {
  const { guideId } = await params;
  if (!helpGuideMeta(guideId)) notFound();
  const { lang, explicit } = await guideLanguage(searchParams);
  return (
    <LanguageProvider initialLang={lang} forceInitialLang={explicit}>
      <HelpGuidePage lang={lang} copy={helpCentreCopy(lang)} guideId={guideId} />
    </LanguageProvider>
  );
}
