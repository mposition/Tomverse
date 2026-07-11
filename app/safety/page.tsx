import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { infoPages } from "@/components/marketing/marketingInfoContent";

export default function SafetyPage() {
  return <MarketingInfoPage content={infoPages.safety} />;
}
