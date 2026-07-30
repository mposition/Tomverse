import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { infoPages } from "@/components/marketing/marketingInfoContent";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Safety and Trust",
  description:
    "Explore Tomverse Insight safety principles, model transparency, security boundaries, privacy controls, and incident practices.",
  path: "/safety",
});

export default function SafetyPage() {
  return <MarketingInfoPage content={infoPages.safety} />;
}
