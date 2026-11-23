"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { ChatWorkspaceProduct } from "@/lib/chatProductUiCopy";
import { isExplicitReasoningEffort, type ReasoningEffort } from "@/lib/reasoningEffort";

const preferenceChanged = "tomverse:reasoning-effort-changed";
const sessionPreferences = new Map<string, ReasoningEffort>();

const subscribe = (notify: () => void) => {
  window.addEventListener(preferenceChanged, notify);
  window.addEventListener("storage", notify);
  return () => {
    window.removeEventListener(preferenceChanged, notify);
    window.removeEventListener("storage", notify);
  };
};

const defaultPreference = (): ReasoningEffort => "default";

export function useReasoningEffortPreference(
  product: ChatWorkspaceProduct | undefined,
  identityKey: string | null,
) {
  const key = product ? `tomverse:reasoning-effort:${product}:${identityKey ?? "guest"}` : null;
  const read = useCallback((): ReasoningEffort => {
    if (!key) return "default";
    const sessionPreference = sessionPreferences.get(key);
    if (sessionPreference) return sessionPreference;
    try {
      const saved = localStorage.getItem(key);
      if (saved === "default" || isExplicitReasoningEffort(saved)) return saved;
    } catch { /* Keep the preference available until this tab closes. */ }
    return "default";
  }, [key]);
  const effort = useSyncExternalStore(subscribe, read, defaultPreference);

  const setEffort = (level: ReasoningEffort) => {
    if (!key) return;
    try {
      localStorage.setItem(key, level);
      sessionPreferences.delete(key);
    } catch {
      sessionPreferences.set(key, level);
    }
    window.dispatchEvent(new Event(preferenceChanged));
  };

  return [effort, setEffort] as const;
}
