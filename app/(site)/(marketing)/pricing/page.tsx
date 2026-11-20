import { PricingPage } from "@/components/marketing/v2/pricing/PricingPage";
import { publicMarketingPageMetadata } from "@/lib/publicMarketingMetadata";

export const metadata = publicMarketingPageMetadata("/pricing");

export default function Page() {
  return <PricingPage />;
}
