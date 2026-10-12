import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { focusedSafetyPages } from "@/components/marketing/marketingInfoContent";
import { publicMarketingPageMetadata } from "@/lib/publicMarketingMetadata";

export const metadata = publicMarketingPageMetadata("/safety/approach");

export default function SafetyApproachPage() {
  return <MarketingInfoPage content={focusedSafetyPages.approach} />;
}
