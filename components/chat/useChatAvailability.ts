"use client";

import { useEffect, useRef, useState } from "react";
import type { WebSearchMode } from "@/lib/appDefaults";

/**
 * Server-authoritative "can this request run right now".
 *
 * The composer already knows whether the account can *afford* a request, from
 * the credit balances it holds. What it cannot know client-side is the state of
 * the internal cost guardrails and the provider spend budgets, which live in
 * server-side usage buckets. Before this, that only surfaced as an error after
 * the user pressed send.
 *
 * Refreshes whenever the model selection or the web-search mode changes, since
 * those are exactly what move the estimate. Read-only: the endpoint reserves
 * nothing and increments nothing.
 */
export type ChatAvailability = {
  runnable: boolean;
  blockCode: string | null;
  blockLayer: "entitlement" | "operational_guardrail" | "other" | null;
  entitlement: {
    dailyCreditLimit: number;
    dailyCreditsUsed: number;
    dailyCreditsRemaining: number | null;
    hasDailyCreditLimit: boolean;
    planCreditsRemaining: number;
    purchasedCreditsRemaining: number;
    creditsAvailableNow: number;
    creditShortfall: number;
    timeZone: string;
    dailyResetsAt: string;
    planResetsAt: string;
  };
  estimate: {
    requiredCredits: number;
    planCreditsUsedByRequest: number;
    purchasedCreditsUsedByRequest: number;
    models: Array<{
      modelId: string;
      credits: number;
      estimatedInputTokens: number;
      estimatedOutputTokens: number;
    }>;
  };
};

const REFRESH_DEBOUNCE_MS = 250;

export function useChatAvailability({
  enabled,
  modelIds,
  webSearchMode,
}: {
  enabled: boolean;
  modelIds: string[];
  webSearchMode: WebSearchMode;
}) {
  // Keyed by the probe it answered, so a selection or mode change discards the
  // previous answer by derivation instead of by clearing state in an effect --
  // a stale "cannot run" notice on a selection the user has already changed
  // would be worse than showing nothing.
  const [answer, setAnswer] = useState<{
    key: string;
    value: ChatAvailability | null;
  } | null>(null);
  // Sorted and joined so a re-render that produces an equal-but-new array does
  // not re-probe; only a real selection change does.
  const selectionKey = [...modelIds].sort().join(",");
  const probeKey = `${webSearchMode}|${selectionKey}`;
  const latestRequest = useRef(0);

  useEffect(() => {
    if (!enabled || !selectionKey) return;
    const controller = new AbortController();
    const requestId = latestRequest.current + 1;
    latestRequest.current = requestId;

    const timer = setTimeout(() => {
      void fetch("/api/chat/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify({
          modelIds: selectionKey.split(","),
          webSearchMode,
        }),
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          // A stale response must never overwrite a newer one.
          if (requestId !== latestRequest.current) return;
          setAnswer({
            key: probeKey,
            value: data && typeof data === "object" ? data : null,
          });
        })
        .catch(() => {});
    }, REFRESH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, probeKey, selectionKey, webSearchMode]);

  if (!enabled || !selectionKey) return null;
  return answer?.key === probeKey ? answer.value : null;
}
