import { LanguageProvider } from "@/components/LanguageProvider";
import { LandingPageContent } from "@/components/marketing/LandingPageContent";
import { MarketingChatAvailabilityProvider } from "@/components/marketing/MarketingChatAvailability";
import { PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE } from "@/lib/landingWorkspaceEntry";
import { REVIEW_PRODUCT_PATH } from "@/lib/marketingRoutes";
import { createPageMetadata, reviewOgCopy, reviewSeoCopy } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: reviewSeoCopy.en.title,
  description: reviewSeoCopy.en.description,
  path: REVIEW_PRODUCT_PATH,
  localizedBasePath: REVIEW_PRODUCT_PATH,
  ogTitle: reviewOgCopy.en.title,
  ogDescription: reviewOgCopy.en.description,
});

export default function ReviewProductPage() {
  return (
    <LanguageProvider initialLang="en" forceInitialLang>
      <MarketingChatAvailabilityProvider guestTrialAvailable={PUBLIC_GUEST_CHAT_TRIAL_AVAILABLE}>
        <LandingPageContent />
      </MarketingChatAvailabilityProvider>
    </LanguageProvider>
  );
}
