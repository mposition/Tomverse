import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { focusedSafetyPages } from "@/components/marketing/marketingInfoContent";

export default function SafetySecurityPrivacyPage() {
  return <MarketingInfoPage content={focusedSafetyPages.securityPrivacy} />;
}
