import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { infoPages } from "@/components/marketing/marketingInfoContent";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "About",
  description:
    "Learn how Tomverse Insight brings multi-model comparison, file analysis, conversation organization, and privacy controls into one workspace.",
  path: "/about",
});

export default function AboutPage() {
  return <MarketingInfoPage content={infoPages.about} />;
}
