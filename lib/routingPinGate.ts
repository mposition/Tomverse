/**
 * Provider / deployment pin, ADR v2.1 §3.5.
 *
 * A pin is a hard override. It shrinks the candidate set to its target and
 * turns exploration off. Capability, quality, version, residency and
 * credential gates still apply to that target; this function does not waive
 * them and does not know their answers.
 *
 * The default fallback is `error`. A pin that cannot be served stays
 * unserved. `allow` is the only policy that may leave the pin for the
 * general pool, and only for a candidate the pin itself did not accept.
 *
 * The request path does not call this. `freezeRequestPolicy` is the pair a
 * request holds from the moment it starts (ADR v2.1 §2.1): the control-plane
 * manifest and the account policy, together. The two columns on RoutingRun
 * are dark. This module does not write them. There is no workspace in this
 * product, so the ADR's workspace policy is the account policy.
 */

export const PIN_SCOPES = ["provider", "deployment"] as const;

export type PinScope = (typeof PIN_SCOPES)[number];

export const PIN_FALLBACK_POLICIES = ["error", "allow"] as const;

export type PinFallbackPolicy = (typeof PIN_FALLBACK_POLICIES)[number];

export type RoutingPin = {
    scope: string;
    providerId?: string | null;
    deploymentId?: string | null;
    fallbackPolicy?: string | null;
};

export type PinCandidate = {
    providerId: string;
    deploymentId: string;
};

export type PinDecision =
    | { pinned: false }
    | {
          pinned: true;
          eligible: boolean;
          exploreRate: 0;
          fallbackPolicy: PinFallbackPolicy;
      };

const named = (value: string | null | undefined): value is string =>
    typeof value === "string" && value.trim().length > 0;

const present = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;

const fallbackPolicy = (value: string | null | undefined): PinFallbackPolicy =>
    value === "allow" ? "allow" : "error";

/**
 * Whether this candidate is inside the pin, and whether a miss may use the
 * general pool.
 *
 * No pin is not a restriction. A scope this module does not know, or a pin
 * whose target id is blank, accepts nobody. Exploration is 0 for every pin.
 */
export const decideRoutingPin = (
    pin: RoutingPin | null | undefined,
    candidate: PinCandidate
): PinDecision => {
    if (!pin) return { pinned: false };
    const policy = fallbackPolicy(pin.fallbackPolicy);
    const eligible =
        pin.scope === "provider"
            ? named(pin.providerId) && pin.providerId === candidate.providerId
            : pin.scope === "deployment"
              ? named(pin.deploymentId) && pin.deploymentId === candidate.deploymentId
              : false;
    return {
        pinned: true,
        eligible,
        exploreRate: 0,
        fallbackPolicy: policy,
    };
};

/**
 * Whether a miss may be served by the general pool.
 *
 * True only for an explicit `allow` on a candidate the pin refused. An
 * eligible candidate is the pin target, so the pool is not the answer.
 * `error`, and every policy other than `allow`, stays here as false.
 */
export const pinPermitsGeneralPool = (decision: PinDecision): boolean =>
    decision.pinned && !decision.eligible && decision.fallbackPolicy === "allow";

/**
 * Whether the policy version captured at admission is still the one in force.
 *
 * Both sides have to be present and equal. A missing version is not "the
 * current one", and a version that moved after admission is a different
 * policy than the one the request started under.
 */
export const pinPolicyVersionHeld = (input: {
    admittedPolicyVersion: string | null | undefined;
    currentPolicyVersion: string | null | undefined;
}): boolean =>
    named(input.admittedPolicyVersion) &&
    input.admittedPolicyVersion === input.currentPolicyVersion;

export type RequestPolicyFreeze = Readonly<{
    controlPlaneVersion: string;
    accountPolicyVersion: string;
}>;

/**
 * Capture both versions, or capture nothing.
 *
 * One side without the other is not a freeze. A blank version is not the
 * current one. The strings are kept as read: trimming them would make a
 * different policy look like the one that was current.
 */
export const freezeRequestPolicy = (observed: {
    controlPlaneVersion: unknown;
    accountPolicyVersion: unknown;
}): RequestPolicyFreeze | null => {
    if (!present(observed.controlPlaneVersion) || !present(observed.accountPolicyVersion)) {
        return null;
    }
    return Object.freeze({
        controlPlaneVersion: observed.controlPlaneVersion,
        accountPolicyVersion: observed.accountPolicyVersion,
    });
};

/**
 * The versions a decision may use.
 *
 * There is no argument for a later read. The freeze is the only policy this
 * request has, and a freeze that is missing either side is not one.
 */
export const policyVersionsForDecision = (
    freeze: RequestPolicyFreeze | null | undefined
): RequestPolicyFreeze | null => {
    if (!freeze || !named(freeze.controlPlaneVersion) || !named(freeze.accountPolicyVersion)) {
        return null;
    }
    return Object.freeze({
        controlPlaneVersion: freeze.controlPlaneVersion,
        accountPolicyVersion: freeze.accountPolicyVersion,
    });
};

/**
 * Whether both frozen versions are still the ones in force.
 *
 * False when the freeze is missing, when either current version is missing,
 * and when either side has moved. Each side uses `pinPolicyVersionHeld`, so
 * a pin and this freeze cannot disagree about what "the same version" means.
 */
export const requestPolicyFreezeHeld = (input: {
    freeze: RequestPolicyFreeze | null | undefined;
    currentControlPlaneVersion: unknown;
    currentAccountPolicyVersion: unknown;
}): boolean => {
    const frozen = policyVersionsForDecision(input.freeze);
    if (!frozen) return false;
    return (
        pinPolicyVersionHeld({
            admittedPolicyVersion: frozen.controlPlaneVersion,
            currentPolicyVersion:
                typeof input.currentControlPlaneVersion === "string"
                    ? input.currentControlPlaneVersion
                    : null,
        }) &&
        pinPolicyVersionHeld({
            admittedPolicyVersion: frozen.accountPolicyVersion,
            currentPolicyVersion:
                typeof input.currentAccountPolicyVersion === "string"
                    ? input.currentAccountPolicyVersion
                    : null,
        })
    );
};
