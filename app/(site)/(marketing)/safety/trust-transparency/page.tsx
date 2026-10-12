import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { focusedSafetyPages } from "@/components/marketing/marketingInfoContent";
import { publicMarketingPageMetadata } from "@/lib/publicMarketingMetadata";

export const metadata = publicMarketingPageMetadata("/safety/trust-transparency");

export default function SafetyTrustTransparencyPage() {
  return <MarketingInfoPage content={focusedSafetyPages.trustTransparency} />;
}
