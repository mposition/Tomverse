import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { infoPages } from "@/components/marketing/marketingInfoContent";
import { publicMarketingPageMetadata } from "@/lib/publicMarketingMetadata";

export const metadata = publicMarketingPageMetadata("/faq");

export default function FaqPage() {
  return <MarketingInfoPage content={infoPages.faq} />;
}
