import { SupportPageContent } from "@/components/marketing/SupportPageContent";
import { publicMarketingPageMetadata } from "@/lib/publicMarketingMetadata";

export const metadata = publicMarketingPageMetadata("/support");

export default function SupportPage() {
  return <SupportPageContent />;
}
