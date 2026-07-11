import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { focusedSafetyPages } from "@/components/marketing/marketingInfoContent";

export default function SafetyTrustTransparencyPage() {
  return <MarketingInfoPage content={focusedSafetyPages.trustTransparency} />;
}
