import { LanguageProvider } from "@/components/LanguageProvider";
import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { searchIntentPages } from "@/components/marketing/searchIntentContent";
import { createPageMetadata } from "@/lib/seo";

const copy = searchIntentPages["chatgpt-vs-claude"].en;

export const metadata = createPageMetadata({
  title: copy.metadataTitle,
  description: copy.metadataDescription,
  path: "/chatgpt-vs-claude",
  localizedBasePath: "/chatgpt-vs-claude",
});

export default function ChatGptVsClaudePage() {
  return (
    <LanguageProvider initialLang="en" forceInitialLang>
      <MarketingInfoPage
        content={searchIntentPages["chatgpt-vs-claude"]}
        template="chatgpt-vs-claude"
      />
    </LanguageProvider>
  );
}
