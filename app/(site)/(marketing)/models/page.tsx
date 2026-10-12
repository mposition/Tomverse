import { ModelsPageContent } from "@/components/marketing/ModelsPageContent";
import { publicMarketingPageMetadata } from "@/lib/publicMarketingMetadata";

export const metadata = publicMarketingPageMetadata("/models");

export default function ModelsPage() {
  return <ModelsPageContent />;
}
