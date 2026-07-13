import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { focusedSafetyPages } from "@/components/marketing/marketingInfoContent";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Safety Approach",
  description:
    "How Tomverse applies layered controls, transparent limitations, user responsibility, and incident response to multi-model AI use.",
  path: "/safety/approach",
});

export default function SafetyApproachPage() {
  return <MarketingInfoPage content={focusedSafetyPages.approach} />;
}
