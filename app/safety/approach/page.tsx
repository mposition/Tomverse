import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { focusedSafetyPages } from "@/components/marketing/marketingInfoContent";

export default function SafetyApproachPage() {
  return <MarketingInfoPage content={focusedSafetyPages.approach} />;
}
