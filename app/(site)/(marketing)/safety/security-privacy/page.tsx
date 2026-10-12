import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { focusedSafetyPages } from "@/components/marketing/marketingInfoContent";
import { publicMarketingPageMetadata } from "@/lib/publicMarketingMetadata";

export const metadata = publicMarketingPageMetadata("/safety/security-privacy");

export default function SafetySecurityPrivacyPage() {
  return <MarketingInfoPage content={focusedSafetyPages.securityPrivacy} />;
}
