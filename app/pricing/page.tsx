import { PricingPageContent } from "@/components/marketing/PricingPageContent";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Pricing",
  description:
    "Compare Tomverse Free, Pro, and Max plans for multi-model AI comparison, file analysis, usage limits, sharing, and workspace features.",
  path: "/pricing",
});

export default function PricingPage() {
  return <PricingPageContent />;
}
