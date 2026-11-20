import { LanguageProvider } from "@/components/LanguageProvider";
import { GuidePage } from "@/components/marketing/v2/guides/GuidePage";
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
      <GuidePage slug="chatgpt-vs-claude" />
    </LanguageProvider>
  );
}
