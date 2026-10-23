"use client";

import { signOut as nextAuthSignOut } from "next-auth/react";
import { clearOfflineChatDraft } from "./chatOfflineDraft";

/** Clear tab-private drafts before NextAuth can navigate away from the app. */
export const signOut = ((...arguments_: Parameters<typeof nextAuthSignOut>) => {
  clearOfflineChatDraft();
  return nextAuthSignOut(...arguments_);
}) as typeof nextAuthSignOut;
