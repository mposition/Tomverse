"use client";

import { useSyncExternalStore } from "react";
import { getSupersededIds, subscribeSuperseded } from "@/lib/chatSupersededTurns";

const EMPTY: ReadonlySet<string> = new Set();

/** The ids of messages this browser has replaced in a conversation. */
export function useSupersededIds(conversationId: string | null | undefined): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeSuperseded,
    () => getSupersededIds(conversationId),
    () => EMPTY
  );
}
