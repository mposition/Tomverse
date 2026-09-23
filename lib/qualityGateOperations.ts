/**
 * Quality-gate expiry and drift scheduling.
 *
 * Pure. Nothing reads a deployment row. The status stored on a row and the
 * status a request may trust diverge once the expiry instant has passed: the
 * row can still say `passed` until a writer that is allowed to touch it flips
 * the row. This module is that flip, stated without performing it.
 *
 * Drift thresholds are not here. A caller that has already judged a named
 * signal reports whether it exceeded. This module does not invent the number
 * that judgement used, and it does not measure the signal.
 */

import {
    DEPLOYMENT_QUALITY_GATE_STATUSES,
    type DeploymentQualityGateStatus,
} from "@/lib/deploymentIdentity";

/**
 * The signals a drift report may name. A report uses one of these. Anything else is not
 * evidence that the gate is still current.
 */
export const QUALITY_DRIFT_SIGNALS = [
    "malformed_output_rate",
    "structured_format_pass",
    "tool_call_exactness",
    "finish_reason_mix",
    "output_token_distribution",
    "reported_revision_change",
    "unexpected_truncation",
] as const;

export type QualityDriftSignal = (typeof QUALITY_DRIFT_SIGNALS)[number];

export type QualityGateClock = {
    status: string | null | undefined;
    expiresAt?: Date | null;
    at: Date;
};

const knownStatus = (
    status: string | null | undefined
): status is DeploymentQualityGateStatus =>
    typeof status === "string" &&
    (DEPLOYMENT_QUALITY_GATE_STATUSES as readonly string[]).includes(status);

const expiryMillis = (expiresAt: Date | null | undefined): number | null => {
    if (!expiresAt) return null;
    const millis = expiresAt.getTime();
    return Number.isNaN(millis) ? null : millis;
};

/**
 * The status a request should believe.
 *
 * `pending`, `failed` and `stale` do not become something else because a
 * clock moved. `passed` stays `passed` only while `at` is strictly before
 * the expiry instant. The instant itself is `stale`: admission is
 * `now < expiresAt`. A pass with no expiry is not rewritten to `stale` —
 * nothing expired — and production admission refuses it on its own.
 * An unknown status is null. It is not a pass.
 */
export const effectiveQualityGateStatus = (
    clock: QualityGateClock
): DeploymentQualityGateStatus | null => {
    if (!knownStatus(clock.status)) return null;
    if (clock.status !== "passed") return clock.status;
    const expires = expiryMillis(clock.expiresAt);
    if (expires === null) return "passed";
    if (clock.at.getTime() < expires) return "passed";
    return "stale";
};

const namedTier = (value: string | null | undefined): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

/**
 * Using the effective status rather than the stored one.
 *
 * The required tier and the deployment tier both have to be present and
 * equal. Blank is not a tier. Eligibility also requires a pass that has not
 * reached its expiry, which a missing expiry cannot satisfy.
 *
 * There is no emergency override here. The ADR keeps that on a separate
 * audit record, and a boolean on this function would be that override
 * without the record.
 */
export const qualityGateAdmitsProduction = (input: {
    requiredQualityTier: string | null | undefined;
    qualityTier: string | null | undefined;
    status: string | null | undefined;
    expiresAt?: Date | null;
    at: Date;
}): boolean => {
    const required = namedTier(input.requiredQualityTier);
    const tier = namedTier(input.qualityTier);
    if (!required || !tier || required !== tier) return false;
    if (effectiveQualityGateStatus(input) !== "passed") return false;
    const expires = expiryMillis(input.expiresAt);
    if (expires === null) return false;
    return input.at.getTime() < expires;
};

/**
 * The row write an expiry is, when one is due.
 *
 * A stored `passed` that has reached its expiry becomes `stale`, and the
 * row cannot stay enabled: the database requires `enabled` to be false
 * unless the stored status is `passed`. Both change together. Anything that
 * is not a passed row past its expiry is not this write.
 */
export const qualityGateExpiryWrite = (
    clock: QualityGateClock
): { qualityGateStatus: "stale"; enabled: false } | null => {
    if (clock.status !== "passed") return null;
    if (effectiveQualityGateStatus(clock) !== "stale") return null;
    return { qualityGateStatus: "stale", enabled: false };
};

export type QualityDriftReport = {
    signal: string;
    exceeded: boolean;
};

/**
 * Whether a re-gate should be scheduled before expiry.
 *
 * True when any known signal is reported exceeded. An unknown signal name
 * is also true: an unnamed movement is not "still valid". A known signal
 * reported as not exceeded does not schedule. An empty list does not.
 */
export const driftRevalidationDue = (
    reports: readonly QualityDriftReport[]
): boolean =>
    reports.some((report) => {
        const known = (QUALITY_DRIFT_SIGNALS as readonly string[]).includes(report.signal);
        if (!known) return true;
        return report.exceeded === true;
    });
