import type { Metadata } from "next";
import { headers } from "next/headers";
import { LanguageProvider } from "@/components/LanguageProvider";
import { AssistantKnowledgeGuide } from "@/components/marketing/AssistantKnowledgeGuide";
import {
  isAssistantPackageImportEnabled,
} from "@/lib/appSettings";
import {
  configuredAssistantKnowledgeSupademoEmbeds,
} from "@/lib/assistantKnowledgeSupademo";
import { DOCUMENT_LANGUAGE_HEADER, isSupportedDocumentLanguage } from "@/lib/documentLanguage";
import { assistantKnowledgeMetadata } from "@/lib/publicMarketingMetadata";

export const dynamic = "force-dynamic";

type KnowledgeGuidePageProps = {
  searchParams: Promise<{ lang?: string | string[] }>;
};

async function guideLanguage({ searchParams }: KnowledgeGuidePageProps) {
  const query = await searchParams;
  const requested = Array.isArray(query.lang) ? query.lang[0] : query.lang;
  if (isSupportedDocumentLanguage(requested)) return { lang: requested, explicit: true };
  const documentLanguage = (await headers()).get(DOCUMENT_LANGUAGE_HEADER);
  return {
    lang: isSupportedDocumentLanguage(documentLanguage) ? documentLanguage : "en" as const,
    explicit: false,
  };
}

export async function generateMetadata(props: KnowledgeGuidePageProps): Promise<Metadata> {
  const { lang } = await guideLanguage(props);
  return assistantKnowledgeMetadata(lang);
}

async function packageImportAvailableForGuide() {
  try {
    return await isAssistantPackageImportEnabled();
  } catch (error) {
    console.warn("Assistant Knowledge guide package flag read failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return false;
  }
}

export default async function AssistantKnowledgeGuidePage(props: KnowledgeGuidePageProps) {
  const { lang, explicit } = await guideLanguage(props);
  const packageImportAvailable = await packageImportAvailableForGuide();

  return (
    <LanguageProvider initialLang={lang} forceInitialLang={explicit}>
      <AssistantKnowledgeGuide
        packageImportAvailable={packageImportAvailable}
        supademoEmbeds={configuredAssistantKnowledgeSupademoEmbeds()}
      />
    </LanguageProvider>
  );
}
