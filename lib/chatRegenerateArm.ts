/**
 * "Try another model" on a finished answer opens the model picker and waits.
 * The answer is requested again only when the model in use actually changes
 * while the wait is still live. The wait ends as soon as the picker is closed:
 * a model chosen afterwards from the ordinary picker is a normal model change,
 * not a request to spend credits on this answer again. A wait that has run out
 * never sends anything.
 */

export const REGENERATE_ARM_TTL_MS = 60_000;

/**
 * Choosing a model can close the picker in the same click. The close is only
 * counted once this long has passed without a model change, so a pick that
 * closes the picker still fires and a later, unrelated pick does not.
 */
export const REGENERATE_ARM_CLOSE_GRACE_MS = 400;

export type RegenerateArmDecision = "wait" | "fire" | "expire";

export function decideArmedRegenerate(input: {
  armedModelId: string;
  currentModelId: string | null | undefined;
  armedAt: number;
  now: number;
  ttlMs?: number;
  /** When the picker was closed after the wait began; null while it is open. */
  pickerClosedAt?: number | null;
  closeGraceMs?: number;
}): RegenerateArmDecision {
  if (input.now - input.armedAt > (input.ttlMs ?? REGENERATE_ARM_TTL_MS)) return "expire";
  if (
    input.pickerClosedAt != null &&
    input.now - input.pickerClosedAt > (input.closeGraceMs ?? REGENERATE_ARM_CLOSE_GRACE_MS)
  ) {
    return "expire";
  }
  if (input.currentModelId && input.currentModelId !== input.armedModelId) return "fire";
  return "wait";
}

/** How long a "wait" decision may stand before it has to be looked at again. */
export function regenerateArmRecheckInMs(input: {
  armedAt: number;
  now: number;
  pickerClosedAt?: number | null;
  ttlMs?: number;
  closeGraceMs?: number;
}): number {
  const ttlLeft = (input.ttlMs ?? REGENERATE_ARM_TTL_MS) - (input.now - input.armedAt);
  const graceLeft =
    input.pickerClosedAt == null
      ? Number.POSITIVE_INFINITY
      : (input.closeGraceMs ?? REGENERATE_ARM_CLOSE_GRACE_MS) - (input.now - input.pickerClosedAt);
  return Math.max(0, Math.min(ttlLeft, graceLeft) + 1);
}
