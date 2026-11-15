/**
 * How much of the user's credits one use of a model takes, shown without the
 * credit number (owner decision 2026-11-15): a five-step meter on one scale for
 * chat and image models alike, and how many uses the credits the user has left
 * would pay for.
 *
 * One scale on purpose. A meter judged among image models only would give a
 * 45-credit image one bar and a 16-credit chat model four, and the same mark
 * would mean two different things on a screen about spending.
 */

/** A model is at level N when it costs at most USAGE_METER_CEILINGS[N - 1] credits; above the last is 5. */
export const USAGE_METER_CEILINGS = [2, 8, 24, 60] as const;
export const USAGE_METER_LEVELS = USAGE_METER_CEILINGS.length + 1;
export type UsageMeterLevel = 1 | 2 | 3 | 4 | 5;

export const usageMeterLevel = (credits: number): UsageMeterLevel => {
  const index = USAGE_METER_CEILINGS.findIndex((ceiling) => credits <= ceiling);
  return ((index < 0 ? USAGE_METER_CEILINGS.length : index) + 1) as UsageMeterLevel;
};

/**
 * How many uses of a model the remaining credits cover, or null when the
 * balance is unknown (a guest, or usage not loaded) -- then only the meter is
 * shown. Floored: a part of a use is not a use.
 */
export const remainingUses = (availableCredits: number | null | undefined, credits: number): number | null => {
  if (availableCredits === null || availableCredits === undefined) return null;
  if (!Number.isFinite(availableCredits) || !Number.isFinite(credits) || credits <= 0) return null;
  return Math.max(0, Math.floor(availableCredits / credits));
};

/**
 * The count as an approximation: two significant figures, rounded down, so
 * "about 3,100" never promises more than the balance covers and does not tick
 * with every message.
 */
export const approximateUses = (uses: number): number => {
  if (uses < 100) return uses;
  const magnitude = 10 ** (Math.floor(Math.log10(uses)) - 1);
  return Math.floor(uses / magnitude) * magnitude;
};
