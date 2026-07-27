// Reaching the comparison cap is a normal constraint, not an error, and it was
// being told to the user three times at once (header count, a full-width amber
// warning, footer count) while pushing the actual model catalogue off screen.
// One derivation so the header keeps the primary status and everything else
// can reference the same numbers without repeating them.

export type ModelSelectionLimit = {
  selectedCount: number;
  maxCount: number;
  limitReached: boolean;
  /** How many more models the user may still add. Never negative. */
  remainingSlots: number;
  /** True when adding one more would require removing something first. */
  requiresSwapToAdd: boolean;
};

export function deriveModelSelectionLimit({
  selectedCount,
  maxCount,
}: {
  selectedCount: number;
  maxCount: number;
}): ModelSelectionLimit {
  const safeMax = Math.max(0, maxCount);
  const limitReached = selectedCount >= safeMax;

  return {
    selectedCount,
    maxCount: safeMax,
    limitReached,
    remainingSlots: Math.max(0, safeMax - selectedCount),
    requiresSwapToAdd: limitReached,
  };
}
