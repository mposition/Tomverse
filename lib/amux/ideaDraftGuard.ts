/**
 * Whether the Ideas tab holds unsaved idea input. The idea text is never kept
 * in browser storage, so leaving for another idea would lose it for good: the
 * input panel reports its draft here and the progress list asks before it
 * navigates away. One module-level flag; client components only.
 */
let unsavedDraft = false;

export function setAmuxIdeaUnsavedDraft(value: boolean): void {
  unsavedDraft = value;
}

export function amuxIdeaHasUnsavedDraft(): boolean {
  return unsavedDraft;
}
