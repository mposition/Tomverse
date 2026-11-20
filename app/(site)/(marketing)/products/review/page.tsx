import { LanguageProvider } from "@/components/LanguageProvider";
import { ReviewProductPage } from "@/components/marketing/v2/review/ReviewProductPage";
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

export default function Page() {
  return (
    <LanguageProvider initialLang="en" forceInitialLang>
      <ReviewProductPage />
    </LanguageProvider>
  );
}
