import { SafetyPage as SafetyPageV2 } from "@/components/marketing/v2/policy/SafetyPage";
import { infoPages } from "@/components/marketing/marketingInfoContent";
import { policyDocumentCards } from "@/components/marketing/v2/policy/policyDocumentCards";
import { publicMarketingPageMetadata } from "@/lib/publicMarketingMetadata";

export const metadata = publicMarketingPageMetadata("/safety");

export default function SafetyPage() {
  return <SafetyPageV2 content={infoPages.safety} documents={policyDocumentCards()} />;
}
