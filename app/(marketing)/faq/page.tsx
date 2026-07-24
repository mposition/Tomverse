import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { infoPages } from "@/components/marketing/marketingInfoContent";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Frequently Asked Questions",
  description:
    "Answers about Tomverse Insight models, accounts, file attachments, sharing, billing, and usage limits.",
  path: "/faq",
});

export default function FaqPage() {
  return <MarketingInfoPage content={infoPages.faq} />;
}
