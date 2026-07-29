import { SupportPageContent } from "@/components/marketing/SupportPageContent";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Support",
  description:
    "Get help with Tomverse accounts, AI models, attachments, billing, sharing, errors, and service incidents.",
  path: "/support",
});

export default function SupportPage() {
  return <SupportPageContent />;
}
