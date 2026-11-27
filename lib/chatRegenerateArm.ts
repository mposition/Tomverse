/**
 * "Try another model" on a finished answer opens the model picker and waits.
 * The answer is requested again only when the model in use actually changes
 * while the wait is still live; closing the picker without choosing, or
 * picking the model already in use, ends the wait quietly after a short time.
 * Nothing is ever sent for a wait that has run out.
 */

export const REGENERATE_ARM_TTL_MS = 60_000;

export type RegenerateArmDecision = "wait" | "fire" | "expire";

export function decideArmedRegenerate(input: {
  armedModelId: string;
  currentModelId: string | null | undefined;
  armedAt: number;
  now: number;
  ttlMs?: number;
}): RegenerateArmDecision {
  if (input.now - input.armedAt > (input.ttlMs ?? REGENERATE_ARM_TTL_MS)) return "expire";
  if (input.currentModelId && input.currentModelId !== input.armedModelId) return "fire";
  return "wait";
}
