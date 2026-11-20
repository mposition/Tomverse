import { LanguageProvider } from "@/components/LanguageProvider";
import { GuidePage } from "@/components/marketing/v2/guides/GuidePage";
import { searchIntentPages } from "@/components/marketing/searchIntentContent";
import { createPageMetadata } from "@/lib/seo";

const copy = searchIntentPages["ai-for-file-analysis"].en;

export const metadata = createPageMetadata({
  title: copy.metadataTitle,
  description: copy.metadataDescription,
  path: "/ai-for-file-analysis",
  localizedBasePath: "/ai-for-file-analysis",
});

export default function AiForFileAnalysisPage() {
  return (
    <LanguageProvider initialLang="en" forceInitialLang>
      <GuidePage slug="ai-for-file-analysis" />
    </LanguageProvider>
  );
}
