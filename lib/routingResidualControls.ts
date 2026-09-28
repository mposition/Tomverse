/**
 * Appendix R1, R3 and R6 of ADR v2.1.
 *
 * R1 stores an affinity deployment and an epoch, and refuses a displacement
 * while a supplied hold-down window is open. A missing window is not a
 * duration this module chooses: the displacement does not happen.
 *
 * R3 does not sleep the current request on Retry-After. That signal is a
 * later request's capacity fact. A deadline is a positive millisecond count
 * the caller supplies. Absent, the deadline check does not fire.
 *
 * R6 orders a fallback chain so a different failure domain comes first. It
 * does not change who was selected first, and it does not invent tag values
 * beyond the host and credential domain this repository already derives.
 *
 * The request path does not call this. Nothing here writes a row.
 */

import { sharesFailureDomain, type FailureDomainInput } from "@/lib/failureDomain";
import { MAX_MODEL_FALLBACKS } from "@/lib/routingFallbackPolicy";

/** Primary build plus one substitution. The fallback budget is the source. */
export const MAX_DISPATCHED_ATTEMPTS = MAX_MODEL_FALLBACKS + 1;

/** Retry-After never delays the request that received it. */
export const currentRequestSleepsForRetryAfter = false;

export type SessionAffinity = {
    deploymentId: string;
    epoch: number;
};

export type AffinityDisplacement =
    | { ok: true; affinity: SessionAffinity }
    | {
          ok: false;
          reason: "blank_deployment" | "bad_state" | "bad_clock" | "duration_unspecified" | "hold_down";
      };

const named = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;

const wholeEpoch = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0;

const finiteDate = (value: unknown): value is Date =>
    value instanceof Date && Number.isFinite(value.getTime());

/**
 * Place or displace a session's affinity.
 *
 * The first placement is epoch 0 and needs no window. Staying on the same
 * deployment does not spend an epoch. A different deployment needs a window
 * the caller supplied, and the window is open strictly before its instant.
 */
export const displaceSessionAffinity = (input: {
    current: { deploymentId: unknown; epoch: unknown } | null;
    nextDeploymentId: unknown;
    holdDownUntil: unknown;
    at: unknown;
}): AffinityDisplacement => {
    if (!named(input.nextDeploymentId)) return { ok: false, reason: "blank_deployment" };
    if (!finiteDate(input.at)) return { ok: false, reason: "bad_clock" };
    if (input.current === null) {
        return { ok: true, affinity: { deploymentId: input.nextDeploymentId, epoch: 0 } };
    }
    if (!named(input.current.deploymentId) || !wholeEpoch(input.current.epoch)) {
        return { ok: false, reason: "bad_state" };
    }
    if (input.current.deploymentId === input.nextDeploymentId) {
        return {
            ok: true,
            affinity: {
                deploymentId: input.current.deploymentId,
                epoch: input.current.epoch,
            },
        };
    }
    if (!finiteDate(input.holdDownUntil)) return { ok: false, reason: "duration_unspecified" };
    if (input.at.getTime() < input.holdDownUntil.getTime()) {
        return { ok: false, reason: "hold_down" };
    }
    return {
        ok: true,
        affinity: {
            deploymentId: input.nextDeploymentId,
            epoch: input.current.epoch + 1,
        },
    };
};

/**
 * Whether `now` has reached the deadline.
 *
 * Null when the deadline is missing, not positive, or either clock is not a
 * finite date. Null is not "still inside the window".
 */
export const requestDeadlineReached = (input: {
    startedAt: unknown;
    deadlineMs: unknown;
    now: unknown;
}): boolean | null => {
    if (typeof input.deadlineMs !== "number" || !Number.isFinite(input.deadlineMs) || input.deadlineMs <= 0) {
        return null;
    }
    if (!finiteDate(input.startedAt) || !finiteDate(input.now)) return null;
    return input.now.getTime() >= input.startedAt.getTime() + input.deadlineMs;
};

/**
 * Different failure domain first. Order inside each group is kept.
 *
 * This is the fallback chain, not the primary ranking. A candidate that
 * shares fate with the attempt it replaces is still in the chain; it is
 * simply not the next one.
 */
export const orderFallbackByFailureDomain = <T extends FailureDomainInput>(
    failed: FailureDomainInput,
    chain: readonly T[]
): T[] => {
    const different: T[] = [];
    const same: T[] = [];
    for (const candidate of chain) {
        if (sharesFailureDomain(failed, candidate)) same.push(candidate);
        else different.push(candidate);
    }
    return [...different, ...same];
};
