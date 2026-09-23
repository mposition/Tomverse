/**
 * Whether one grain of one observation may be applied.
 *
 * The key is the event, the grain, and the target together. Applying the
 * provider rollup does not mean the deployment rollup was applied. A blank
 * id or an unknown grain is not "already applied". Nothing here writes a
 * row. The request path does not import this module.
 */

import {
    AVAILABILITY_ROLLUP_GRAINS,
    type AvailabilityRollupGrain,
} from "@/lib/availabilityObservation";

export type RollupApplyRefusal = "blank" | "unknown_grain" | "already_applied";

export type RollupApplyDecision =
    | { apply: true; key: string }
    | { apply: false; reason: RollupApplyRefusal };

const isGrain = (value: string): value is AvailabilityRollupGrain =>
    (AVAILABILITY_ROLLUP_GRAINS as readonly string[]).includes(value);

/** The identity a projection stores. The separator cannot appear in the three parts as a join. */
export const rollupApplicationKey = (eventId: string, grain: string, targetId: string): string =>
    `${eventId.length}:${eventId}\n${grain.length}:${grain}\n${targetId.length}:${targetId}`;

/**
 * Apply this triple once.
 *
 * `alreadyApplied` holds keys from `rollupApplicationKey`. A key that is
 * already there is `already_applied`. A blank event or target, or a grain
 * outside the observation list, is refused before that lookup.
 */
export const shouldApplyRollup = (
    input: { eventId: string; grain: string; targetId: string },
    alreadyApplied: ReadonlySet<string>
): RollupApplyDecision => {
    if (input.eventId.length === 0 || input.targetId.length === 0) {
        return { apply: false, reason: "blank" };
    }
    if (!isGrain(input.grain)) return { apply: false, reason: "unknown_grain" };
    const key = rollupApplicationKey(input.eventId, input.grain, input.targetId);
    if (alreadyApplied.has(key)) return { apply: false, reason: "already_applied" };
    return { apply: true, key };
};
