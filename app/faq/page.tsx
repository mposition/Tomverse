import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { infoPages } from "@/components/marketing/marketingInfoContent";

export default function FaqPage() {
  return <MarketingInfoPage content={infoPages.faq} />;
}
