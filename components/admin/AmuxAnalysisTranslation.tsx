"use client";

import { useState } from "react";

import { adminFetch } from "@/lib/adminFetch";
import type { AdminMessageShape } from "@/lib/adminLocale";
import type { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import type { AmuxIdeaAnalysisResultView } from "@/lib/amux/ideaAnalysisResultReadCore";
import { amuxAnalysisTranslationViewKey,
  amuxAnalysisViewReadable } from "@/lib/amux/ideaAnalysisTranslationCore";

type Messages = AdminMessageShape<(typeof adminAmuxIdeaInputMessages)["en"]>;
export type AmuxTranslationRequestState = "loading" | "too_large" | "unavailable" | null;

/** A model's Korean reading of the English text right above it; never the text that counts. */
export function AmuxKoText({ m, text }: { m: Messages; text: string | undefined }) {
  if (!text) return null;
  return <p lang="ko" data-testid="amux-ko-translation"
    className="mt-1 whitespace-pre-wrap rounded border-l-2 border-emerald-500/60 bg-emerald-500/5 px-2 py-1 text-zinc-200">
    <span className="mr-1 text-xs font-medium text-emerald-300">{m.translationLabel}</span>{text}
  </p>;
}

export function AmuxTranslationToggle({ m, shown, state, stale, onToggle }: {
  m: Messages; shown: boolean; state: AmuxTranslationRequestState; stale: boolean;
  onToggle: () => void;
}) {
  return <div className="space-y-1" data-testid="amux-translation-toggle">
    <button type="button" onClick={onToggle} disabled={state === "loading"} aria-pressed={shown}
      className="min-h-11 rounded-lg border px-4 disabled:opacity-50 border-emerald-600/60">
      {state === "loading" ? m.translationLoading : shown ? m.translationHide : m.translationShow}
    </button>
    <p className="text-xs text-zinc-400">{m.translationHint}</p>
    {state === "too_large" ? <p role="status">{m.translationTooLarge}</p> : null}
    {state === "unavailable" ? <p role="alert">{m.translationUnavailable}</p> : null}
    {stale && state === null ? <p role="status">{m.translationStale}</p> : null}
  </div>;
}

/**
 * The translation of the shown result page, asked for only when the owner
 * presses the button. The server reads the text itself; this sends only the
 * idea and page. A translation of another page or preview is never shown.
 */
export function useAmuxAnalysisTranslation(ideaId: string, chunkIndex: number,
  view: AmuxIdeaAnalysisResultView | null) {
  const [shown, setShown] = useState(false);
  const [state, setState] = useState<AmuxTranslationRequestState>(null);
  const [result, setResult] = useState<{ viewKey: string; translations: Record<string, string> } | null>(null);
  const viewKey = amuxAnalysisViewReadable(view) ? amuxAnalysisTranslationViewKey(view) : null;
  const matches = result !== null && viewKey !== null && result.viewKey === viewKey;
  const current = shown && matches;

  const toggle = async () => {
    if (state === "loading") return;
    if (current) { setShown(false); return; }
    setShown(true);
    if (matches) return;
    setState("loading");
    try {
      const response = await adminFetch("/api/admin/amux/ideas/analysis-translation", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ideaId, chunkIndex }) });
      const body: unknown = await response.json().catch(() => null);
      const translations = (body as { translations?: unknown } | null)?.translations;
      const key = (body as { viewKey?: unknown } | null)?.viewKey;
      if (response.ok && typeof key === "string" && translations !== null &&
          typeof translations === "object" && !Array.isArray(translations)) {
        setResult({ viewKey: key, translations: translations as Record<string, string> });
        setState(null);
      } else setState(response.status === 413 ? "too_large" : "unavailable");
    } catch { setState("unavailable"); }
  };

  const ko = (id: string): string | undefined => {
    if (!current || !result) return undefined;
    const text = result.translations[id];
    return typeof text === "string" ? text : undefined;
  };
  return { shown: current, state,
    stale: shown && result !== null && viewKey !== null && !matches, toggle, ko };
}
