import { ModelsPage } from "@/components/marketing/v2/models/ModelsPage";
import { publicMarketingPageMetadata } from "@/lib/publicMarketingMetadata";

export const metadata = publicMarketingPageMetadata("/models");

export default function Page() {
  return <ModelsPage />;
}
