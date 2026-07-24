import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";
import { focusedSafetyPages } from "@/components/marketing/marketingInfoContent";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Security and Privacy",
  description:
    "Learn how Tomverse protects accounts, conversations, attachments, shared links, and provider requests.",
  path: "/safety/security-privacy",
});

export default function SafetySecurityPrivacyPage() {
  return <MarketingInfoPage content={focusedSafetyPages.securityPrivacy} />;
}
