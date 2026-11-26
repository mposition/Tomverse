"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useLanguage } from "@/components/LanguageProvider";
import { reviewWorkspaceCopy } from "@/lib/reviewWorkspaceCopy";
import type { ConversationProductKey } from "@/lib/conversationProduct";

// The settings modal lives inside AuthButton, and the navigation's Settings and
// avatar buttons open this drawer to reach it. A drawer without AuthButton would
// open empty and leave those buttons doing nothing.
const AccountButton = dynamic(() => import("@/components/auth/AuthButton").then(module => module.AuthButton));

/**
 * The navigation drawer for a workspace that keeps no conversation list of its
 * own (Studio, Plugins): a way back to the chat history, plus the account and
 * settings panel.
 */
export function WorkspaceAccountPanel({ currentProduct }: { currentProduct: ConversationProductKey }) {
  const { lang } = useLanguage();
  return <aside className="review-account-panel" data-testid="workspace-account-panel">
    <Link href={{ pathname: "/chat", query: { lang } }}>{reviewWorkspaceCopy[lang].openHistory}</Link>
    <AccountButton currentProduct={currentProduct} showAnalyticsCookieButton />
  </aside>;
}
