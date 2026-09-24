/**
 * Names the scope of one failure without widening it to a whole provider.
 *
 * The live stream classifier still returns a generic provider scope. This
 * module does not replace it and the request path does not import it.
 * A provider id is not an endpoint id. When the gateway and the serving
 * side differ and the caller has not said which side failed, the result
 * abstains. An unknown category abstains. Nothing reads or writes a row.
 */

import type { ProviderFailureCategory, ProviderFailureScope } from "@/lib/providerErrorClassification";

export const CANONICAL_FAILURE_CLASSIFICATION_VERSION = 1;

export const CANONICAL_SCOPE_KINDS = [
    "gateway",
    "serving_endpoint",
    "deployment",
    "model",
    "local",
] as const;

export type CanonicalScopeKind = (typeof CANONICAL_SCOPE_KINDS)[number];

export type FailureProvenance = "user_abort" | "upstream_timeout" | "provider_reported";

export type ProviderSide = "gateway" | "serving";

export type CanonicalFailureInput = {
    provenance: FailureProvenance;
    category: ProviderFailureCategory | null;
    genericScope: ProviderFailureScope | null;
    providerSide: ProviderSide | null;
    gatewayProviderId: string | null;
    servingProviderId: string | null;
    endpointId: string | null;
    deploymentId: string | null;
    logicalModelId: string | null;
};

export type CanonicalAbstainReason =
    | "invalid_id"
    | "provenance_category_conflict"
    | "missing_category"
    | "unknown_category"
    | "scope_disagreement"
    | "gateway_serving_unresolved"
    | "missing_gateway"
    | "missing_endpoint"
    | "missing_deployment"
    | "missing_model"
    | "insufficient";

export type CanonicalClassification =
    | {
          status: "classified";
          scopeKind: CanonicalScopeKind;
          scopeId: string;
          category: ProviderFailureCategory | null;
          provenance: FailureProvenance;
          version: typeof CANONICAL_FAILURE_CLASSIFICATION_VERSION;
          differentEndpointRequired: boolean;
      }
    | { status: "abstain"; reason: CanonicalAbstainReason };

const CATEGORIES: readonly ProviderFailureCategory[] = [
    "LOCAL_REJECTION",
    "REQUEST_CONTRACT",
    "MODEL_NOT_FOUND",
    "MODEL_TRANSIENT",
    "AUTHENTICATION",
    "PAYMENT_REQUIRED",
    "RATE_LIMIT",
    "SERVER_ERROR",
    "NETWORK",
    "UNKNOWN",
];

const usableId = (value: string | null): string | null | "invalid" => {
    if (value === null) return null;
    if (typeof value !== "string") return "invalid";
    if (value.length === 0 || value.trim().length === 0 || value !== value.trim()) return "invalid";
    return value;
};

const knownCategory = (value: ProviderFailureCategory | null): boolean =>
    value !== null && CATEGORIES.includes(value);

const expectedGenericScope = (
    category: ProviderFailureCategory
): ProviderFailureScope => {
    switch (category) {
        case "LOCAL_REJECTION":
            return "none";
        case "REQUEST_CONTRACT":
        case "MODEL_NOT_FOUND":
        case "MODEL_TRANSIENT":
            return "model";
        case "AUTHENTICATION":
        case "PAYMENT_REQUIRED":
        case "RATE_LIMIT":
        case "SERVER_ERROR":
        case "NETWORK":
        case "UNKNOWN":
            return "provider";
    }
};

const classified = (
    scopeKind: CanonicalScopeKind,
    scopeId: string,
    category: ProviderFailureCategory | null,
    provenance: FailureProvenance,
    differentEndpointRequired: boolean
): CanonicalClassification => ({
    status: "classified",
    scopeKind,
    scopeId,
    category,
    provenance,
    version: CANONICAL_FAILURE_CLASSIFICATION_VERSION,
    differentEndpointRequired,
});

const modelOrDeployment = (input: CanonicalFailureInput, category: ProviderFailureCategory): CanonicalClassification => {
    const deploymentId = usableId(input.deploymentId);
    const logicalModelId = usableId(input.logicalModelId);
    if (deploymentId === "invalid" || logicalModelId === "invalid") {
        return { status: "abstain", reason: "invalid_id" };
    }
    if (logicalModelId === null) return { status: "abstain", reason: "missing_model" };
    if (deploymentId === null) return { status: "abstain", reason: "missing_deployment" };
    return classified("deployment", deploymentId, category, "provider_reported", false);
};

const gatewayScope = (input: CanonicalFailureInput, category: ProviderFailureCategory): CanonicalClassification => {
    const gateway = usableId(input.gatewayProviderId);
    const serving = usableId(input.servingProviderId);
    if (gateway === "invalid" || serving === "invalid") {
        return { status: "abstain", reason: "invalid_id" };
    }
    const sidesDiffer = gateway !== null && serving !== null && gateway !== serving;
    if (sidesDiffer && input.providerSide === null) {
        return { status: "abstain", reason: "gateway_serving_unresolved" };
    }
    if (input.providerSide === "serving") {
        return { status: "abstain", reason: "gateway_serving_unresolved" };
    }
    if (gateway === null) return { status: "abstain", reason: "missing_gateway" };
    return classified("gateway", gateway, category, "provider_reported", false);
};

const endpointScope = (
    input: CanonicalFailureInput,
    category: ProviderFailureCategory
): CanonicalClassification => {
    const endpointId = usableId(input.endpointId);
    const gateway = usableId(input.gatewayProviderId);
    const serving = usableId(input.servingProviderId);
    if (endpointId === "invalid" || gateway === "invalid" || serving === "invalid") {
        return { status: "abstain", reason: "invalid_id" };
    }
    const sidesDiffer = gateway !== null && serving !== null && gateway !== serving;
    if (sidesDiffer && input.providerSide === null) {
        return { status: "abstain", reason: "gateway_serving_unresolved" };
    }
    if (input.providerSide === "gateway") {
        if (gateway === null) return { status: "abstain", reason: "missing_gateway" };
        return classified("gateway", gateway, category, "provider_reported", false);
    }
    if (endpointId === null) return { status: "abstain", reason: "missing_endpoint" };
    return classified("serving_endpoint", endpointId, category, "provider_reported", true);
};

export const classifyCanonicalFailure = (input: CanonicalFailureInput): CanonicalClassification => {
    if (input.provenance === "user_abort") {
        return classified("local", "client", null, "user_abort", false);
    }

    if (input.provenance === "upstream_timeout") {
        if (input.category !== null && input.category !== "NETWORK") {
            return { status: "abstain", reason: "provenance_category_conflict" };
        }
        const endpointId = usableId(input.endpointId);
        if (endpointId === "invalid") return { status: "abstain", reason: "invalid_id" };
        if (endpointId === null) return { status: "abstain", reason: "missing_endpoint" };
        return classified("serving_endpoint", endpointId, "NETWORK", "upstream_timeout", true);
    }

    if (input.category === null) return { status: "abstain", reason: "missing_category" };
    if (!knownCategory(input.category)) return { status: "abstain", reason: "unknown_category" };
    if (input.genericScope !== null && input.genericScope !== expectedGenericScope(input.category)) {
        return { status: "abstain", reason: "scope_disagreement" };
    }

    switch (input.category) {
        case "LOCAL_REJECTION":
            return classified("local", "process", "LOCAL_REJECTION", "provider_reported", false);
        case "REQUEST_CONTRACT":
        case "MODEL_NOT_FOUND":
        case "MODEL_TRANSIENT":
            return modelOrDeployment(input, input.category);
        case "UNKNOWN":
            return { status: "abstain", reason: "insufficient" };
        case "AUTHENTICATION":
        case "PAYMENT_REQUIRED":
            return gatewayScope(input, input.category);
        case "RATE_LIMIT":
        case "SERVER_ERROR":
        case "NETWORK":
            return endpointScope(input, input.category);
    }
};

export type FailureScopedCandidate = {
    deploymentId: string | null;
    logicalModelId: string | null;
    endpointId: string | null;
    gatewayProviderId: string | null;
};

export type FailureScopeRelation =
    | { outside: true }
    | { outside: false; reason: "same_scope" | "unclassified" | "missing_candidate" };

/**
 * Whether a candidate sits outside the failed scope.
 *
 * An abstention is not permission to try another candidate. A model-scoped
 * failure that cannot name its deployment abstains, so no other deployment
 * is cleared by it.
 */
export const candidateOutsideFailureScope = (
    failure: CanonicalClassification,
    candidate: FailureScopedCandidate
): FailureScopeRelation => {
    if (failure.status !== "classified") return { outside: false, reason: "unclassified" };

    const deploymentId = usableId(candidate.deploymentId);
    const logicalModelId = usableId(candidate.logicalModelId);
    const endpointId = usableId(candidate.endpointId);
    const gatewayProviderId = usableId(candidate.gatewayProviderId);
    if (
        deploymentId === "invalid" ||
        logicalModelId === "invalid" ||
        endpointId === "invalid" ||
        gatewayProviderId === "invalid"
    ) {
        return { outside: false, reason: "missing_candidate" };
    }

    switch (failure.scopeKind) {
        case "local":
            return { outside: false, reason: "same_scope" };
        case "deployment":
            if (deploymentId === null) return { outside: false, reason: "missing_candidate" };
            return deploymentId === failure.scopeId
                ? { outside: false, reason: "same_scope" }
                : { outside: true };
        case "model":
            if (logicalModelId === null) return { outside: false, reason: "missing_candidate" };
            return logicalModelId === failure.scopeId
                ? { outside: false, reason: "same_scope" }
                : { outside: true };
        case "serving_endpoint":
            if (endpointId === null) return { outside: false, reason: "missing_candidate" };
            return endpointId === failure.scopeId
                ? { outside: false, reason: "same_scope" }
                : { outside: true };
        case "gateway":
            if (gatewayProviderId === null) return { outside: false, reason: "missing_candidate" };
            return gatewayProviderId === failure.scopeId
                ? { outside: false, reason: "same_scope" }
                : { outside: true };
    }
};
