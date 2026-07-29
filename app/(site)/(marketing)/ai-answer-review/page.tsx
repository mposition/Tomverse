import { LanguageProvider } from "@/components/LanguageProvider";
import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
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
      <MarketingInfoPage
        content={searchIntentPages["ai-answer-review"]}
        template="ai-answer-review"
      />
    </LanguageProvider>
  );
}
