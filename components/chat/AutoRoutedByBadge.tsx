"use client";

import { Sparkles } from "lucide-react";

import {
  autoRoutingCopy,
  autoRoutingReason,
  type AutoRoutingLanguage,
} from "@/lib/autoRoutingCopy";

/**
 * Which model answered this message, on a turn Auto routed.
 *
 * The reason the toggle's copy can promise "the one that answered is shown on
 * the reply" is that this exists. Without it Auto is a mode that silently
 * changes what the user is talking to, and the first time an answer is worse
 * than usual there is nothing to look at.
 *
 * Renders nothing on a turn Auto did not route -- including a turn in an Auto
 * conversation that fell back to the user's own model. A badge on a fallback
 * would claim a routing decision that did not happen, which is the same
 * mistake `lib/autoModelSelection.ts` makes unrepresentable on the server.
 *
 * The reason is optional. `autoRoutingReason` returns null for an identifier
 * this locale has no sentence for, and the badge then shows the model name
 * alone rather than leaking `fallback_order` into somebody's chat.
 */
export function AutoRoutedByBadge({
  routed,
  modelName,
  reason,
  language,
}: {
  routed: boolean;
  /** The display name, not the id: the id is for logs, not for reading. */
  modelName: string;
  /** The router's fixed selection-reason identifier. */
  reason: string | null;
  language: AutoRoutingLanguage;
}) {
  if (!routed || !modelName) return null;
  const copy = autoRoutingCopy[language] ?? autoRoutingCopy.en;
  const explanation = autoRoutingReason(language, reason);

  return (
    <span
      data-testid="auto-routed-by"
      className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 px-2 py-0.5 text-[11px] text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
    >
      <Sparkles aria-hidden="true" className="h-3 w-3" />
      <span>
        {copy.answeredBy} {modelName}
      </span>
      {explanation ? (
        <span className="text-zinc-400 dark:text-zinc-500">— {explanation}</span>
      ) : null}
    </span>
  );
}
