import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SharedConversationView } from "@/components/share/SharedConversationView";
import { isValidShareTokenFormat } from "@/lib/shareTokens";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default async function SharedConversationPage({
  params,
}: {
  params: Promise<{ shareToken: string }>;
}) {
  const { shareToken } = await params;
  if (!isValidShareTokenFormat(shareToken)) notFound();

  return <SharedConversationView shareToken={shareToken} />;
}
