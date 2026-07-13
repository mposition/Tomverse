import { PrivacyPolicy } from "@/components/legal/PrivacyPolicy";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
    title: "Privacy Policy",
    description: "How Tomverse processes account, chat, attachment, analytics, billing-security, and Private Mode data.",
    path: "/privacy",
});

export default function PrivacyPage() {
    return <PrivacyPolicy />;
}
