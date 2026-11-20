import { LanguageProvider } from "@/components/LanguageProvider";
import { ChatProductPage } from "@/components/marketing/v2/chat/ChatProductPage";
import { chatPageSeo } from "@/components/marketing/v2/chat/chatPageContent";
import { CHAT_PRODUCT_PATH } from "@/lib/marketingRoutes";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: chatPageSeo.en.title,
  description: chatPageSeo.en.description,
  path: CHAT_PRODUCT_PATH,
  localizedBasePath: CHAT_PRODUCT_PATH,
});

export default function Page() {
  return (
    <LanguageProvider initialLang="en" forceInitialLang>
      <ChatProductPage />
    </LanguageProvider>
  );
}
