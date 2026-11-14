"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { discardResponseBody } from "@/lib/discardResponseBody";

export type ResearchPreviewControls = {
  offered: boolean;
  selected: boolean;
  pending: boolean;
  estimatedCredits?: number;
  onSelectedChange: (selected: boolean) => void;
};

/** A server offer belongs to this exact account, conversation and model. */
export function useResearchPreview({
  identityKey, conversationId, modelId, question, locale, enabled, revision = "",
}: {
  identityKey: string | null;
  conversationId: string | null;
  modelId: string | undefined;
  question: string;
  locale: string;
  enabled: boolean;
  revision?: string;
}): ResearchPreviewControls {
  const scope = enabled && identityKey && conversationId && modelId
    ? JSON.stringify([identityKey, conversationId, modelId, locale, revision]) : null;
  const requestScope = useMemo(() => ({ scope }), [scope]);
  const [offer, setOffer] = useState<{ requestScope: typeof requestScope; question: string; offered: boolean; estimatedCredits?: number } | null>(null);
  const [selectedScope, setSelectedScope] = useState<typeof requestScope | null>(null);
  useEffect(() => {
    if (!scope || !conversationId || !modelId || !question || question.length > 4000) return;
    const controller = new AbortController();
    const timer = setTimeout(() => { void fetch("/api/chat/research-preview/offer", {
      method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json", "Accept-Language": locale },
      body: JSON.stringify({ conversationId, modelId, question }),
      signal: controller.signal,
    }).then(async response => {
      const value = response.ok ? await response.json().catch(() => null) : await discardResponseBody(response).then(() => null);
      if (controller.signal.aborted) return;
      const estimatedCredits = Number.isSafeInteger(value?.estimatedCredits) && value.estimatedCredits > 0
        ? value.estimatedCredits as number : undefined;
      setOffer({ requestScope, question,
        offered: value?.offered === true && value?.reason === "ready" && estimatedCredits !== undefined,
        ...(estimatedCredits !== undefined ? { estimatedCredits } : {}) }
      );
    }).catch(() => {
      if (!controller.signal.aborted) setOffer({ requestScope, question, offered: false });
    }); }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [scope, requestScope, conversationId, modelId, question, locale]);
  const current = Boolean(scope && question && question.length <= 4000 &&
    offer?.requestScope === requestScope && offer.question === question);
  const offered = Boolean(current && offer?.offered);
  const onSelectedChange = useCallback((selected: boolean) => {
    setSelectedScope(selected && offered ? requestScope : null);
  }, [offered, requestScope]);
  return {
    offered, selected: Boolean(scope && selectedScope === requestScope), pending: !current,
    ...(offered && offer?.estimatedCredits ? { estimatedCredits: offer.estimatedCredits } : {}),
    onSelectedChange,
  };
}
