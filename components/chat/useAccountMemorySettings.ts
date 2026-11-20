"use client";

import { useCallback, useEffect, useState } from "react";

import { discardResponseBody } from "@/lib/discardResponseBody";

export type AccountMemorySettings = {
  masterEnabled: boolean;
  defaultConversationMode: "on" | "off";
};

/** Unknown while loading/failed; an old account's permissions never describe a new one. */
export function useAccountMemorySettings(userId: string | null) {
  const [owner, setOwner] = useState(userId);
  const [snapshot, setSnapshot] = useState<{ userId: string; settings: AccountMemorySettings } | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => {
    setSnapshot(null);
    setRevision(value => value + 1);
  }, []);
  // Reset during render so even A -> B -> A cannot display A's old response.
  if (owner !== userId) {
    setOwner(userId);
    setSnapshot(null);
  }

  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    let current = true;
    void fetch("/api/memories/settings", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) {
          await discardResponseBody(response);
          return null;
        }
        const value = await response.json() as Partial<AccountMemorySettings>;
        return typeof value.masterEnabled === "boolean" &&
          (value.defaultConversationMode === "on" || value.defaultConversationMode === "off")
          ? value as AccountMemorySettings : null;
      })
      .then(settings => {
        if (current) setSnapshot(settings ? { userId, settings } : null);
      })
      .catch(() => { if (current) setSnapshot(null); });
    return () => { current = false; controller.abort(); };
  }, [userId, revision]);

  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);

  return { settings: owner === userId && snapshot?.userId === userId ? snapshot.settings : null, refresh };
}
