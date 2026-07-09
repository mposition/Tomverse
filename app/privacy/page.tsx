import type { Metadata } from "next";
import { PrivacyPolicy } from "@/components/legal/PrivacyPolicy";

export const metadata: Metadata = {
    title: "Privacy Policy | Tomverse",
    description: "How Tomverse processes account, chat, attachment, and Private Mode data.",
};

export default function PrivacyPage() {
    return <PrivacyPolicy />;
}
