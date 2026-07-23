import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { infoPages } from "@/components/marketing/marketingInfoContent";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Refund Policy",
  description:
    "Review Tomverse Insight refund eligibility, billing correction, cancellation, and support request guidance.",
  path: "/refund",
});

export default function RefundPage() {
  return <MarketingInfoPage content={infoPages.refund} />;
}
