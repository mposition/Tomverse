import { LanguageProvider } from "@/components/LanguageProvider";
import { GuidePage } from "@/components/marketing/v2/guides/GuidePage";
import { searchIntentPages } from "@/components/marketing/searchIntentContent";
import { createPageMetadata } from "@/lib/seo";

const copy = searchIntentPages["ai-answer-review"].en;

export const metadata = createPageMetadata({
  title: copy.metadataTitle,
  description: copy.metadataDescription,
  path: "/ai-answer-review",
  localizedBasePath: "/ai-answer-review",
});

export default function AiAnswerReviewPage() {
  return (
    <LanguageProvider initialLang="en" forceInitialLang>
      <GuidePage slug="ai-answer-review" />
    </LanguageProvider>
  );
}
