/**
 * What a classified routing failure is allowed to do.
 *
 * This is not a second error taxonomy. `lib/providerErrorClassification.ts`
 * already says what the provider call was. The question here is the next
 * action: breaker, another deployment, credential disable, alert, retry.
 * Nothing in this file classifies an HTTP status, sends an alert, or writes
 * a row.
 *
 * `transport_corruption` is not named in the classification table. The breaker names it as a
 * breaker subject beside 5xx, connection failure and pre-commit timeout, so
 * it takes that same row. Leaving it out would disagree with the breaker.
 *
 * Pure. The request path does not import this.
 */

export const ROUTING_FAILURE_RESULTS = [
    "rate_limited",
    "server_error",
    "connection_error",
    "pre_commit_timeout",
    "transport_corruption",
    "unsupported_request",
    "credential_rejected",
    "safety_refusal",
    "malformed_output",
    "post_commit_stream_failure",
] as const;

export type RoutingFailureResult = (typeof ROUTING_FAILURE_RESULTS)[number];

/**
 * `required` is a row that says to try the next candidate.
 * `permitted` is the malformed pre-commit fallback, which the ADR allows
 * after the one same-deployment retry and does not require.
 * `forbidden` is a hop or an automatic reroute the ADR names as prohibited.
 * `no` means this row does not send the caller elsewhere.
 */
export type OtherDeployment = "required" | "permitted" | "no" | "forbidden";

export type RoutingFailureDisposition = {
    breaker: boolean;
    otherDeployment: OtherDeployment;
    disableCredentialScope: boolean;
    alert: boolean;
    /** No classification row grants a retry that ignores the failure class. */
    blindRetry: false;
    sameDeploymentRetry: boolean;
    qualityDrift: boolean;
    finishReason: "upstream_error" | null;
};

const AVAILABILITY_RESULTS = new Set<string>([
    "server_error",
    "connection_error",
    "pre_commit_timeout",
    "transport_corruption",
]);

const isResult = (result: string): result is RoutingFailureResult =>
    (ROUTING_FAILURE_RESULTS as readonly string[]).includes(result);

const whole = (value: number) => Number.isInteger(value) && value >= 0;

const quiet = (
    overrides: Partial<RoutingFailureDisposition>
): RoutingFailureDisposition => ({
    breaker: false,
    otherDeployment: "no",
    disableCredentialScope: false,
    alert: false,
    blindRetry: false,
    sameDeploymentRetry: false,
    qualityDrift: false,
    finishReason: null,
    ...overrides,
});

/**
 * The action for one classified result.
 *
 * `committed` is the streaming commit point. `sameDeploymentRetriesUsed` counts
 * retries already spent on this deployment for this result. An unknown
 * result, a non-boolean commit flag, or a retry count that is not a
 * non-negative integer returns null. A post-commit stream failure reported
 * before commit is a contradiction and also returns null.
 */
export const routingFailureDisposition = (input: {
    result: string;
    committed: boolean;
    sameDeploymentRetriesUsed: number;
}): RoutingFailureDisposition | null => {
    if (!isResult(input.result)) return null;
    if (typeof input.committed !== "boolean") return null;
    if (!whole(input.sameDeploymentRetriesUsed)) return null;

    if (input.result === "rate_limited") {
        return quiet({ otherDeployment: "required" });
    }
    if (AVAILABILITY_RESULTS.has(input.result)) {
        return quiet({ breaker: true });
    }
    if (input.result === "unsupported_request") {
        return quiet({});
    }
    if (input.result === "credential_rejected") {
        return quiet({
            otherDeployment: "required",
            disableCredentialScope: true,
            alert: true,
        });
    }
    if (input.result === "safety_refusal") {
        return quiet({ otherDeployment: "forbidden" });
    }
    if (input.result === "post_commit_stream_failure") {
        if (!input.committed) return null;
        return quiet({
            otherDeployment: "forbidden",
            finishReason: "upstream_error",
        });
    }

    if (input.committed) {
        return quiet({
            otherDeployment: "forbidden",
            qualityDrift: true,
        });
    }
    if (input.sameDeploymentRetriesUsed < 1) {
        return quiet({
            sameDeploymentRetry: true,
            qualityDrift: true,
        });
    }
    return quiet({
        otherDeployment: "permitted",
        qualityDrift: true,
    });
};

/**
 * The row write named for 401, 403 and billing, stated and not performed.
 *
 * `disabled` is the CredentialBinding status that means inactive. `revoked`
 * is a different word in the same check, and this row does not say it.
 */
export const credentialDisableWrite = (
    disposition: RoutingFailureDisposition | null
): { status: "disabled" } | null =>
    disposition?.disableCredentialScope === true ? { status: "disabled" } : null;
