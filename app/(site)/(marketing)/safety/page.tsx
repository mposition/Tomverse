import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { infoPages } from "@/components/marketing/marketingInfoContent";
import { publicMarketingPageMetadata } from "@/lib/publicMarketingMetadata";

export const metadata = publicMarketingPageMetadata("/safety");

export default function SafetyPage() {
  return <MarketingInfoPage content={infoPages.safety} />;
}
