import { PricingPageContent } from "@/components/marketing/PricingPageContent";
import { publicMarketingPageMetadata } from "@/lib/publicMarketingMetadata";

export const metadata = publicMarketingPageMetadata("/pricing");

export default function PricingPage() {
  return <PricingPageContent />;
}
