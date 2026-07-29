import { PrivacyPolicy } from "@/components/legal/PrivacyPolicy";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
    title: "Privacy Policy",
    description: "How Tomverse processes account, chat, attachment, analytics, and billing-security data.",
    path: "/privacy",
});

export default function PrivacyPage() {
    return <PrivacyPolicy />;
}
