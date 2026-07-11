import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { infoPages } from "@/components/marketing/marketingInfoContent";

export default function TermsPage() {
  return <MarketingInfoPage content={infoPages.terms} />;
}
