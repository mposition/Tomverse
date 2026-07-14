import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { focusedSafetyPages } from "@/components/marketing/marketingInfoContent";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Trust and Transparency",
  description:
    "Understand Tomverse model-provider boundaries, public status reporting, AI output limitations, and operational transparency.",
  path: "/safety/trust-transparency",
});

export default function SafetyTrustTransparencyPage() {
  return <MarketingInfoPage content={focusedSafetyPages.trustTransparency} />;
}
