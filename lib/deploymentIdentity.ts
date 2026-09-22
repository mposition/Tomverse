/**
 * The vocabularies the deployment identity tables are constrained to.
 *
 * Dark, like the tables. Nothing routes from these yet; they exist so that the
 * closed lists live beside the code that will read them rather than only in a
 * migration, which is what `npm run check:enum-constraints` compares.
 *
 * Design: .github/audits/multi-provider-routing-deployment-identity-design-2026-09-22.md
 *
 * Pure: no database, no clock, no network.
 */

/**
 * Whether we can name where this endpoint takes the data.
 *
 * Two values, and deliberately no third for "probably". The question the
 * routing gate asks is binary -- may a residency-constrained request go here
 * -- and a middle value would be read as a yes by whoever needed one.
 *
 * `unproven` is the honest default rather than a gap. It says nobody has read
 * a contract that names a recipient and a region, which is the state every
 * provider is in until the contract review lands
 * (`lib/providerDataDestinations.ts`).
 */
export const ENDPOINT_RESIDENCY_CLASSES = ["proven", "unproven"] as const;

export type EndpointResidencyClass = (typeof ENDPOINT_RESIDENCY_CLASSES)[number];

/**
 * Where a deployment's own quality evidence stands.
 *
 * Per deployment, not per equivalence class. Two placements of one model may
 * well be interchangeable, but no provider in the pool has been shown to
 * attest the immutable artifact that would let one placement's evidence stand
 * for another's, and sharing it without that hides drift rather than saving
 * work.
 *
 * `stale` is its own value rather than a flavour of `failed`: evidence that
 * expired is not evidence that the model got worse, and collapsing the two
 * would make an expiry read as a regression.
 */
export const DEPLOYMENT_QUALITY_GATE_STATUSES = [
    "pending",
    "passed",
    "failed",
    "stale",
] as const;

export type DeploymentQualityGateStatus =
    (typeof DEPLOYMENT_QUALITY_GATE_STATUSES)[number];

/**
 * Whether a deployment may be switched on.
 *
 * The database holds this as a CHECK as well, because it is the rule an
 * operator would otherwise be able to break with one UPDATE. Stated here too
 * so a caller can refuse before writing rather than catch a constraint error.
 */
export const deploymentMayBeEnabled = (
    qualityGateStatus: DeploymentQualityGateStatus
): boolean => qualityGateStatus === "passed";

/**
 * An approval, as much of one as this decision needs.
 *
 * The regions and recipients are not read here. Whether a *particular*
 * destination is acceptable is the caller's question and depends on the
 * request; this answers the prior one, which is whether there is a live
 * approval at all.
 */
export type ResidencyApprovalFact = {
    effectiveFrom: Date;
    effectiveTo: Date | null;
};

/**
 * Whether an endpoint may carry a request that names a residency constraint.
 *
 * **One authority, and it is the approval.** An earlier draft answered this
 * from `ProviderEndpoint.residencyClass` alone, which made three places able
 * to answer one question -- the provider registry in
 * `lib/providerDataDestinations.ts`, the endpoint's own column, and the
 * approval rows -- and nothing kept them agreeing. A legal question with three
 * answers has none.
 *
 * So `residencyClass` is a cached summary for querying and reporting, not a
 * permission. It has to say `proven` *and* there has to be an approval in
 * force at the moment asked. A class that says `proven` with no live approval
 * is a stale summary, and it is refused rather than believed.
 *
 * Fail-closed throughout: no approval, an expired one, one that has not
 * started, or a class that is anything but `proven` all answer no. An endpoint
 * nobody recorded answers no for the same reason as one recorded and unproven
 * -- nobody can say where the data would go.
 */
export const endpointMayServeConstrainedTraffic = (input: {
    residencyClass: string | null | undefined;
    approvals: readonly ResidencyApprovalFact[];
    at: Date;
}): boolean => {
    if (input.residencyClass !== "proven") return false;
    return input.approvals.some(
        (approval) =>
            approval.effectiveFrom.getTime() <= input.at.getTime() &&
            (approval.effectiveTo === null ||
                approval.effectiveTo.getTime() > input.at.getTime())
    );
};
