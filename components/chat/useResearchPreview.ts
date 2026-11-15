"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { discardResponseBody } from "@/lib/discardResponseBody";

export type ResearchPreviewOfferInput = { conversationId?: string; selectionMode?: "manual" | "auto"; assistantProfileId?: string | null; modelId: string; question: string };

export type ResearchPreviewControls = {
  modelId?: string;
  offered: boolean;
  selected: boolean;
  pending: boolean;
  features?: { pageReading: boolean; durableRuns: boolean };
  estimatedCredits?: number;
  onSelectedChange: (selected: boolean) => void;
};

/** A server offer belongs to this exact account, conversation and model. */
export function useResearchPreview({
  identityKey, conversationId, modelId, question, locale, enabled, assistantProfileId, requestOffer, revision = "",
}: {
  identityKey: string | null;
  conversationId: string | null;
  modelId: string | undefined;
  question: string;
  locale: string;
  enabled: boolean;
  assistantProfileId?: string | null;
  requestOffer?: (input: ResearchPreviewOfferInput, signal?: AbortSignal, locale?: string) => Promise<unknown>;
  revision?: string;
}): ResearchPreviewControls {
  const scope = enabled && identityKey && modelId
    ? JSON.stringify([identityKey, conversationId, modelId, locale, assistantProfileId, revision]) : null;
  const requestScope = useMemo(() => ({ scope }), [scope]);
  const [offer, setOffer] = useState<{ requestScope: typeof requestScope; question: string; offered: boolean; features?: { pageReading: boolean; durableRuns: boolean }; estimatedCredits?: number } | null>(null);
  const [selectedScope, setSelectedScope] = useState<typeof requestScope | null>(null);
  useEffect(() => {
    if (!scope || !modelId || !question || question.length > 4000) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const input: ResearchPreviewOfferInput = { ...(conversationId ? { conversationId } : { selectionMode: "manual", ...(assistantProfileId ? { assistantProfileId } : {}) }), modelId, question };
      const result = requestOffer ? requestOffer(input, controller.signal, locale) : fetch("/api/chat/research-preview/offer", {
        method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", "Accept-Language": locale },
        body: JSON.stringify(input), signal: controller.signal,
      }).then(response => response.ok ? response.json().catch(() => null) : discardResponseBody(response).then(() => null));
      void result.then(valueUnknown => {
      const value = valueUnknown as { offered?: unknown; reason?: unknown; estimatedCredits?: unknown; features?: { pageReading?: unknown; durableRuns?: unknown } } | null;
      if (controller.signal.aborted) return;
      const estimatedCredits = typeof value?.estimatedCredits === "number" && Number.isSafeInteger(value.estimatedCredits) && value.estimatedCredits > 0
        ? value.estimatedCredits as number : undefined;
      setOffer({ requestScope, question,
        offered: value?.offered === true && value?.reason === "ready" && estimatedCredits !== undefined,
        ...(estimatedCredits !== undefined ? { estimatedCredits } : {}),
        ...(value?.features && typeof value.features.pageReading === "boolean" && typeof value.features.durableRuns === "boolean" ? { features: { pageReading: value.features.pageReading, durableRuns: value.features.durableRuns } } : {}) }
      );
    }).catch(() => {
      if (!controller.signal.aborted) setOffer({ requestScope, question, offered: false });
    }); }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [scope, requestScope, conversationId, modelId, question, locale, assistantProfileId, requestOffer]);
  const current = Boolean(scope && question && question.length <= 4000 &&
    offer?.requestScope === requestScope && offer.question === question);
  const offered = Boolean(current && offer?.offered);
  const onSelectedChange = useCallback((selected: boolean) => {
    setSelectedScope(selected && offered ? requestScope : null);
  }, [offered, requestScope]);
  return {
    modelId, offered, selected: Boolean(scope && selectedScope === requestScope), pending: !current,
    ...(offered && offer?.estimatedCredits ? { estimatedCredits: offer.estimatedCredits } : {}),
    ...(offered && offer?.features ? { features: offer.features } : {}),
    onSelectedChange,
  };
}
