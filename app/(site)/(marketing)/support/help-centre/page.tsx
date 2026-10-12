import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { infoPages } from "@/components/marketing/marketingInfoContent";
import { publicMarketingPageMetadata } from "@/lib/publicMarketingMetadata";

export const metadata = publicMarketingPageMetadata("/support/help-centre");

export default function HelpCentrePage() {
  return <MarketingInfoPage content={infoPages.helpCentre} />;
}
