/**
 * The seven held routing decisions, as refusals.
 *
 * None of these turn a feature on. The request path does not import this
 * module. Nothing here calls a provider, writes a row, or reads a price.
 */

const named = (value: string | null): value is string =>
    typeof value === "string" && value.length > 0 && value === value.trim();

const wholeAtLeastOne = (value: number) => Number.isInteger(value) && value >= 1;

/** A provider probe is a connectivity hint, never proof of another deployment. */
export const interpretProviderProbe = (input: {
    succeeded: boolean;
    sameProvider: boolean;
    probeDeploymentId: string | null;
    subjectDeploymentId: string | null;
}): { deploymentProven: false; connectivityHint: boolean } => {
    // Naming the two deployments is required. Neither id is allowed to
    // turn a probe success into deployment proof.
    void input.probeDeploymentId;
    void input.subjectDeploymentId;
    return {
        deploymentProven: false,
        connectivityHint: input.succeeded === true && input.sameProvider === true,
    };
};

export type ObservationMode = "shadow" | "replicated_call";

/** A shadow choice did not call the provider. A replicated call spends and can disturb a shared cache. */
export const interpretObservationMode = (
    mode: ObservationMode
): { spent: boolean; observedProviderReality: boolean; sharedCacheMayDistort: boolean } => {
    if (mode === "replicated_call") {
        return { spent: true, observedProviderReality: true, sharedCacheMayDistort: true };
    }
    return { spent: false, observedProviderReality: false, sharedCacheMayDistort: false };
};

export type CanaryExecutionRefusal =
    | "production_traffic"
    | "user_traffic"
    | "production_environment"
    | "unnamed_environment"
    | "unnamed_scope"
    | "unnamed_stop"
    | "missing_cost_ceiling";

/**
 * Non-production rehearsal is the only stage this module can accept, and
 * only when the caller has already named the environment, the experiment,
 * and the stop. A provider call also needs a positive cost ceiling the
 * caller supplied. Production traffic is a different approval.
 */
export const admitCanaryExecution = (input: {
    productionTraffic: boolean;
    userTraffic: boolean;
    environmentName: string | null;
    experimentScope: string | null;
    stopCondition: string | null;
    callsProvider: boolean;
    costCeiling: number | null;
}): { admitted: false; reason: CanaryExecutionRefusal } | { admitted: true; productionWeightChange: false } => {
    if (input.productionTraffic) return { admitted: false, reason: "production_traffic" };
    if (input.userTraffic) return { admitted: false, reason: "user_traffic" };
    if (!named(input.environmentName)) return { admitted: false, reason: "unnamed_environment" };
    if (input.environmentName.toLowerCase() === "production") {
        return { admitted: false, reason: "production_environment" };
    }
    if (!named(input.experimentScope)) return { admitted: false, reason: "unnamed_scope" };
    if (!named(input.stopCondition)) return { admitted: false, reason: "unnamed_stop" };
    if (input.callsProvider) {
        if (typeof input.costCeiling !== "number" || !Number.isFinite(input.costCeiling) || input.costCeiling <= 0) {
            return { admitted: false, reason: "missing_cost_ceiling" };
        }
    }
    return { admitted: true, productionWeightChange: false };
};

/** BYOK cost wiring stays inactive. A failure does not move the bill onto a managed key. */
export const BYOK_COST_POSTURE = "inactive" as const;

export const byokFailurePosture = (): {
    posture: typeof BYOK_COST_POSTURE;
    switchBillingOwner: false;
    chargeManagedKeyAsUserCredit: false;
} => ({
    posture: BYOK_COST_POSTURE,
    switchBillingOwner: false,
    chargeManagedKeyAsUserCredit: false,
});

/**
 * Softmax is unset. Zero is not how "off" is stored, and an unset
 * temperature does not disarm the load guard.
 */
export const SOFTMAX_TEMPERATURE = null;

export const LOAD_GUARD_STAYS_ARMED_WITHOUT_SOFTMAX = true;

export const softmaxConfigured = (temperature: number | null): boolean =>
    typeof temperature === "number" && Number.isFinite(temperature) && temperature > 0;

export const distributionCandidate = (input: { passedHardGates: boolean }): { eligible: boolean } => ({
    eligible: input.passedHardGates === true,
});

export const DEPLOYMENT_PRICE_KNOWLEDGE = ["unknown", "estimate", "verified"] as const;

export type PriceKnowledge = (typeof DEPLOYMENT_PRICE_KNOWLEDGE)[number];

/** One rate of the named currency per million tokens. The same split `lib/modelPricing.ts` already bills. */
export const DEPLOYMENT_PRICE_RATE_KINDS = ["input", "output", "cache_read", "cache_write"] as const;

export type DeploymentPriceRateKind = (typeof DEPLOYMENT_PRICE_RATE_KINDS)[number];

export const DEPLOYMENT_PRICE_UNIT = "per_million_tokens" as const;

const PRICE_INTEGER_DIGITS = 12;
const PRICE_SCALE = 8;

const currencyCode = (value: string | null): value is string => named(value) && /^[A-Z]{3}$/.test(value);

const canonicalEffectiveAt = (value: string | null): value is string => {
    if (!named(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
    return new Date(value).toISOString() === value;
};

/**
 * DECIMAL(20,8) rounds a smaller positive amount to zero and rejects an
 * amount with more than twelve digits left of the point. Either result
 * would store a different price from the one the caller named, so both
 * are refused before a row exists.
 */
const amountFitsDecimal = (amount: number): boolean => {
    if (!Number.isFinite(amount) || amount < 0 || amount >= 10 ** PRICE_INTEGER_DIGITS) return false;
    return Number(amount.toFixed(PRICE_SCALE)) === amount;
};

export type PriceRecordRefusal =
    | "unknown_has_amount"
    | "incomplete_known_price"
    | "unrecognized_knowledge"
    | "unrecognized_rate"
    | "unrecognized_unit"
    | "amount_not_representable"
    | "invalid_currency"
    | "invalid_effective_at"
    | "missing_placement";

/**
 * A record-only snapshot keeps an unknown price unknown. A stated estimate
 * or verified price may be zero when its source and effective time are
 * named; that zero is not an unknown amount filled in. The amount is one
 * named rate, in the named currency, per million tokens. Applying any
 * snapshot to routing or to a credit charge is a separate approval this
 * module refuses.
 */
export const recordDeploymentPrice = (input: {
    knowledge: PriceKnowledge;
    rateKind: string | null;
    unit: string | null;
    amount: number | null;
    currency: string | null;
    source: string | null;
    effectiveAt: string | null;
}):
    | { recorded: false; reason: PriceRecordRefusal }
    | { recorded: true; appliedToRouting: false; appliedToBilling: false } => {
    if (!(DEPLOYMENT_PRICE_KNOWLEDGE as readonly string[]).includes(input.knowledge)) {
        return { recorded: false, reason: "unrecognized_knowledge" };
    }
    if (!(DEPLOYMENT_PRICE_RATE_KINDS as readonly string[]).includes(input.rateKind ?? "")) {
        return { recorded: false, reason: "unrecognized_rate" };
    }
    if (input.unit !== DEPLOYMENT_PRICE_UNIT) {
        return { recorded: false, reason: "unrecognized_unit" };
    }
    if (input.knowledge === "unknown") {
        if (input.amount !== null) return { recorded: false, reason: "unknown_has_amount" };
        return { recorded: true, appliedToRouting: false, appliedToBilling: false };
    }
    if (typeof input.amount !== "number" || !Number.isFinite(input.amount) || input.amount < 0) {
        return { recorded: false, reason: "incomplete_known_price" };
    }
    if (!amountFitsDecimal(input.amount)) {
        return { recorded: false, reason: "amount_not_representable" };
    }
    if (!named(input.currency) || !named(input.source) || !named(input.effectiveAt)) {
        return { recorded: false, reason: "incomplete_known_price" };
    }
    if (!currencyCode(input.currency)) return { recorded: false, reason: "invalid_currency" };
    if (!canonicalEffectiveAt(input.effectiveAt)) return { recorded: false, reason: "invalid_effective_at" };
    return { recorded: true, appliedToRouting: false, appliedToBilling: false };
};

/**
 * The columns a record-only deployment price would store.
 *
 * Nothing inserts them. Routing and billing stay closed, including when
 * the price itself is complete.
 */
export const deploymentPriceSnapshotColumns = (input: {
    modelDeploymentId: string | null;
    logicalModelId: string | null;
    knowledge: PriceKnowledge;
    rateKind: string | null;
    unit: string | null;
    amount: number | null;
    currency: string | null;
    source: string | null;
    effectiveAt: string | null;
}):
    | { recorded: false; reason: PriceRecordRefusal }
    | {
          recorded: true;
          modelDeploymentId: string;
          logicalModelId: string;
          knowledge: PriceKnowledge;
          rateKind: DeploymentPriceRateKind;
          unit: typeof DEPLOYMENT_PRICE_UNIT;
          amount: number | null;
          currency: string | null;
          source: string | null;
          effectiveAt: string | null;
          appliedToRouting: false;
          appliedToBilling: false;
      } => {
    if (!named(input.modelDeploymentId) || !named(input.logicalModelId)) {
        return { recorded: false, reason: "missing_placement" };
    }
    const price = recordDeploymentPrice(input);
    if (!price.recorded) return price;
    return {
        recorded: true,
        modelDeploymentId: input.modelDeploymentId,
        logicalModelId: input.logicalModelId,
        knowledge: input.knowledge,
        rateKind: input.rateKind as DeploymentPriceRateKind,
        unit: DEPLOYMENT_PRICE_UNIT,
        amount: input.amount,
        currency: input.currency,
        source: input.source,
        effectiveAt: input.effectiveAt,
        appliedToRouting: false,
        appliedToBilling: false,
    };
};

export const applyPriceSnapshot = (): { applied: false; reason: "behavior_change_unapproved" } => ({
    applied: false,
    reason: "behavior_change_unapproved",
});

/**
 * A missing deployment sample stays insufficient. The probe field is
 * accepted so a caller must name it, and it is never copied in as the
 * observation.
 */
export const deploymentEvidence = (input: {
    observationCount: number;
    probeSucceeded: boolean;
}): { status: "insufficient" | "observed"; usedProbe: false } => {
    void input.probeSucceeded;
    if (!Number.isInteger(input.observationCount) || input.observationCount <= 0) {
        return { status: "insufficient", usedProbe: false };
    }
    return { status: "observed", usedProbe: false };
};

export const DECISION_GRAIN_CUTOVER = "held" as const;

export const bindRequestVersion = (input: {
    inFlight: boolean;
    startedVersion: string | null;
    approvedVersion: string | null;
}): { version: string } | { version: null; reason: "missing_version" } => {
    const chosen = input.inFlight ? input.startedVersion : input.approvedVersion;
    if (!named(chosen)) return { version: null, reason: "missing_version" };
    return { version: chosen };
};

export type FallbackConnectionRefusal =
    | "invalid_attempt_count"
    | "unknown_sdk_retries"
    | "provider_budget_exceeded"
    | "after_visible_commit"
    | "side_effect_unconfirmed"
    | "target_unverified"
    | "silent_owner_change";

/**
 * Whether a planned fallback would satisfy the connection contract.
 *
 * `liveActivation` stays false. The live fallback policy is not this
 * function. Provider attempts count Tomverse dispatches and the retries
 * inside each dispatch. An unknown inner retry count cannot be shown to
 * fit in two provider attempts.
 */
export const assessFallbackConnection = (input: {
    tomverseDispatches: number;
    attemptsInsideEachDispatch: number | null;
    userVisibleCommit: boolean;
    externalSideEffect: boolean;
    sideEffectSafetyConfirmed: boolean;
    targetPassedGates: boolean;
    pinOrBillingOwnerChanged: boolean;
}): { permitted: false; reason: FallbackConnectionRefusal; liveActivation: false } | {
    permitted: true;
    providerAttempts: number;
    liveActivation: false;
} => {
    const refused = (reason: FallbackConnectionRefusal) => ({
        permitted: false as const,
        reason,
        liveActivation: false as const,
    });
    if (!wholeAtLeastOne(input.tomverseDispatches)) return refused("invalid_attempt_count");
    if (input.attemptsInsideEachDispatch === null || input.attemptsInsideEachDispatch === undefined) {
        return refused("unknown_sdk_retries");
    }
    if (!wholeAtLeastOne(input.attemptsInsideEachDispatch)) return refused("invalid_attempt_count");
    const providerAttempts = input.tomverseDispatches * input.attemptsInsideEachDispatch;
    if (providerAttempts > 2) return refused("provider_budget_exceeded");
    if (input.userVisibleCommit) return refused("after_visible_commit");
    if (input.externalSideEffect && !input.sideEffectSafetyConfirmed) {
        return refused("side_effect_unconfirmed");
    }
    if (!input.targetPassedGates) return refused("target_unverified");
    if (input.pinOrBillingOwnerChanged) return refused("silent_owner_change");
    return { permitted: true, providerAttempts, liveActivation: false };
};

export type EquivalenceStatus = "unverified" | "evidenced";

/**
 * Two deployments are not an equivalence class because they share a name.
 * Evidence, when both kinds exist, still does not authorize moving a user
 * request. Automatic routing stays closed.
 */
export const assessDeploymentEquivalence = (input: {
    logicalModelId: string | null;
    deploymentIds: readonly string[];
    providerAttestationId: string | null;
    tomverseEvaluationId: string | null;
}): { status: EquivalenceStatus; automaticRouting: false; reason: "scope" | "missing_evidence" | "both_evidences" } => {
    const ids = input.deploymentIds.length === 2 ? input.deploymentIds.filter(named) : [];
    const distinct = new Set(ids);
    if (!named(input.logicalModelId) || input.deploymentIds.length !== 2 || distinct.size !== 2 || ids.length !== 2) {
        return { status: "unverified", automaticRouting: false, reason: "scope" };
    }
    const provider = named(input.providerAttestationId);
    const evaluation = named(input.tomverseEvaluationId);
    if (provider && evaluation) {
        return { status: "evidenced", automaticRouting: false, reason: "both_evidences" };
    }
    return { status: "unverified", automaticRouting: false, reason: "missing_evidence" };
};
