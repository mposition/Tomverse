/** Shared Web/Native copy for the bounded, independent answer comparison. */
export const reviewContinuationHandoffCopy = {
  scope: (sourceTurnCount: number, nativeTurnCount: number) =>
    `${sourceTurnCount} imported excerpts and ${nativeTurnCount} earlier Chat messages. The selected answer is excluded.`,
  omitted: (nativeOmittedCount: number) =>
    `${nativeOmittedCount} earlier Chat messages are outside this comparison's context limit.`,
  sourceOmitted: (sourceOmittedCount: number) =>
    `${sourceOmittedCount} imported messages are outside this comparison's context limit.`,
  legacy: "This answer has no recorded source excerpts. Recent imported messages are reconstructed; the original selected or retrieved excerpts cannot be verified.",
  multiModel: "Every selected model receives the same references after you press Send.",
  preparing: "Preparing a new Review draft…",
  attachmentsUnsupported: "Comparisons that need attachments are not supported yet.",
  completedOnly: "Only saved, completed text answers can be compared.",
  unsupported: "This comparison supports text questions only.",
  questionTooLong: "This question exceeds the 50,000 character input limit for Review.",
  modeUnsupported: "This comparison supports text answers only. Research and images are not supported.",
  unavailable: "These references are unavailable. Reopen the original Chat to prepare this comparison again.",
  failed: "The Review draft could not be prepared. Try this answer again.",
  draftSaving: "Saving this Review draft…",
  draftFailed: "This draft could not be synchronized. Your text is still here; retry before sending or leaving.",
  draftConflict: "This Review draft changed elsewhere. Your text is still here. Load the saved draft before continuing.",
  retryDraft: "Retry draft sync",
  reloadDraft: "Load saved draft",
} as const;
