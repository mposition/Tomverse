"use client";

import { autoRoutingCopy, type AutoRoutingLanguage } from "@/lib/autoRoutingCopy";

/**
 * How Auto read the message, under a reply that answered the router's rewrite
 * of it (docs/ui-contracts/prompt-refiner-suggestion.md, "Auto router rewrite").
 *
 * Collapsed by default: the answer is the content, this is provenance. It
 * renders only beside the Auto badge, so it can never appear on a turn Auto
 * did not route, and it says what happened -- never that the rewrite helped.
 */
export function AutoRewriteDisclosure({
  rewrite,
  language,
}: {
  rewrite: string;
  language: AutoRoutingLanguage;
}) {
  const copy = autoRoutingCopy[language] ?? autoRoutingCopy.en;
  return (
    <details data-testid="auto-rewrite" className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
      <summary className="inline-flex min-h-11 cursor-pointer items-center">{copy.rewriteSummary}</summary>
      <p className="mt-1 whitespace-pre-wrap rounded-xl border border-zinc-200 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-200">
        {rewrite}
      </p>
      <p className="mt-1">{copy.rewriteNote}</p>
    </details>
  );
}
