import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { infoPages } from "@/components/marketing/marketingInfoContent";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Help Centre",
  description:
    "Practical guidance for using Tomverse Insight accounts, plans, models, file attachments, sharing, privacy, and support diagnostics.",
  path: "/support/help-centre",
});

export default function HelpCentrePage() {
  return <MarketingInfoPage content={infoPages.helpCentre} />;
}
