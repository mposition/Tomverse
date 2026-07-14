import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { infoPages } from "@/components/marketing/marketingInfoContent";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Terms and Conditions",
  description:
    "Read the terms governing accounts, acceptable use, AI outputs, third-party providers, paid plans, and access to Tomverse AI.",
  path: "/terms",
});

export default function TermsPage() {
  return <MarketingInfoPage content={infoPages.terms} />;
}
