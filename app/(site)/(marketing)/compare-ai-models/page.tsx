import { LanguageProvider } from "@/components/LanguageProvider";
import { GuidePage } from "@/components/marketing/v2/guides/GuidePage";
import { searchIntentPages } from "@/components/marketing/searchIntentContent";
import { createPageMetadata } from "@/lib/seo";

const copy = searchIntentPages["compare-ai-models"].en;

export const metadata = createPageMetadata({
  title: copy.metadataTitle,
  description: copy.metadataDescription,
  path: "/compare-ai-models",
  localizedBasePath: "/compare-ai-models",
});

export default function CompareAiModelsPage() {
  return (
    <LanguageProvider initialLang="en" forceInitialLang>
      <GuidePage slug="compare-ai-models" />
    </LanguageProvider>
  );
}
