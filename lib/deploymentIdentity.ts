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

/**
 * What a capacity limit is counted against.
 *
 * Five kinds, each naming exactly the columns it needs. The first design was a
 * single `(scopeKind, scopeId)` pair of strings, and it was rejected in review
 * for a reason worth keeping written down: nothing stops a scope id that
 * matches no row, and **a limit counted against nothing is indistinguishable
 * from no limit** until somebody spends against it.
 *
 * `account` rather than `workspace`. BYOK ownership is the account, so there
 * is no workspace entity for a scope to point at.
 */
export const QUOTA_SCOPE_KINDS = [
    /** One credential, wherever it is used. */
    "credential",
    /** One credential at one endpoint -- the provider's own rate limit. */
    "endpoint_credential",
    /** One credential for one deployment -- a per-model quota. */
    "deployment_credential",
    /** One account's own spend, which is not Tomverse's budget. */
    "account",
    /** A whole provider, across every credential we hold for it. */
    "provider",
] as const;

export type QuotaScopeKind = (typeof QUOTA_SCOPE_KINDS)[number];

/**
 * Who funds the calls a credential makes.
 *
 * The distinction decides which budget a request draws down, and they are
 * different namespaces on purpose: an account's own spend must not consume an
 * allowance Tomverse funded. `lib/chatSecurity.ts` reserves one cost figure
 * for three consumers today -- the account guardrail, the Tomverse provider
 * hold and the purchased-credit funded allowance -- and only the first of
 * those is about the person.
 */
export const CREDENTIAL_BILLING_OWNERS = ["tomverse", "account"] as const;

export type CredentialBillingOwner = (typeof CREDENTIAL_BILLING_OWNERS)[number];

/**
 * Whether a binding may be used.
 *
 * `revoked` is separate from `disabled` because they are different facts: one
 * was switched off and can be switched back on, the other was withdrawn and
 * the secret behind it should be assumed gone.
 */
export const CREDENTIAL_BINDING_STATUSES = [
    "disabled",
    "active",
    "revoked",
] as const;

export type CredentialBindingStatus =
    (typeof CREDENTIAL_BINDING_STATUSES)[number];

/**
 * The columns a quota scope of this kind must carry, and must not.
 *
 * The database holds this as a CHECK as well. Stated here so a caller can
 * refuse before writing rather than catch a constraint error, and so the shape
 * is legible without reading SQL.
 */
export const QUOTA_SCOPE_REQUIRED_FIELDS: Readonly<
    Record<QuotaScopeKind, readonly string[]>
> = {
    credential: ["credentialBindingId"],
    endpoint_credential: ["credentialBindingId", "providerEndpointId"],
    deployment_credential: ["credentialBindingId", "modelDeploymentId"],
    account: ["accountId"],
    provider: ["providerId"],
};

const QUOTA_SCOPE_FIELDS = [
    "credentialBindingId",
    "providerEndpointId",
    "modelDeploymentId",
    "accountId",
    "providerId",
] as const;

/**
 * Why a quota scope row is not well formed, or an empty list.
 *
 * Returns the reasons rather than a boolean, so a caller can say which column
 * is wrong instead of only that something is.
 */
export const quotaScopeProblems = (input: {
    scopeKind: string;
    credentialBindingId?: string | null;
    providerEndpointId?: string | null;
    modelDeploymentId?: string | null;
    accountId?: string | null;
    providerId?: string | null;
}): readonly string[] => {
    if (!(QUOTA_SCOPE_KINDS as readonly string[]).includes(input.scopeKind)) {
        return [`unknown scope kind ${JSON.stringify(input.scopeKind)}`];
    }
    const required = QUOTA_SCOPE_REQUIRED_FIELDS[input.scopeKind as QuotaScopeKind];
    const problems: string[] = [];
    for (const field of QUOTA_SCOPE_FIELDS) {
        const present = Boolean(input[field]);
        const wanted = required.includes(field);
        if (wanted && !present) problems.push(`${input.scopeKind} needs ${field}`);
        if (!wanted && present) problems.push(`${input.scopeKind} must not carry ${field}`);
    }
    return problems;
};

/**
 * Whether a binding's funding fields agree with who is paying.
 *
 * An account-funded binding names the account and no Tomverse budget; a
 * Tomverse-funded one is the reverse. Without both halves, "who is paying for
 * this call" has two possible answers and the settlement takes whichever
 * column happens to be set.
 */
export const credentialBindingFundingProblems = (input: {
    billingOwner: string;
    accountId?: string | null;
    providerBudgetAccountId?: string | null;
}): readonly string[] => {
    if (!(CREDENTIAL_BILLING_OWNERS as readonly string[]).includes(input.billingOwner)) {
        return [`unknown billing owner ${JSON.stringify(input.billingOwner)}`];
    }
    const problems: string[] = [];
    if (input.billingOwner === "account") {
        if (!input.accountId) problems.push("an account-funded binding names its account");
        if (input.providerBudgetAccountId) {
            problems.push("an account-funded binding draws down no Tomverse budget");
        }
        return problems;
    }
    if (input.accountId) problems.push("a Tomverse-funded binding names no account");
    if (!input.providerBudgetAccountId) {
        problems.push("a Tomverse-funded binding names the budget it spends against");
    }
    return problems;
};
