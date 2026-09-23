/**
 * Whether a hosted copy may stand in for the catalogue model.
 *
 * The same name is not the same model. The caller supplies the catalogue
 * limits and whatever the host has actually stated. A missing host limit
 * is unproven, not equal. A shorter host limit cannot serve the catalogue
 * promise. Price is not compared here. Nothing reads a row, and the
 * request path does not import this module.
 */

export type CatalogueLimits = {
    logicalModelId: string;
    maxOutputTokens: number;
    contextTokens: number;
};

export type HostCopyLimits = {
    logicalModelId: string;
    deploymentId: string;
    maxOutputTokens: number | null;
    contextTokens: number | null;
};

export type HostCopyRefusal =
    | "different_model"
    | "blank_deployment"
    | "unproven_output"
    | "unproven_context"
    | "shorter_output"
    | "shorter_context"
    | "unusable_catalogue";

export type HostCopyDecision =
    | { ok: true; logicalModelId: string; deploymentId: string }
    | { ok: false; reason: HostCopyRefusal };

const positiveWhole = (value: number): boolean =>
    Number.isInteger(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER;

/**
 * Accept a host copy only when both limits are stated and at least the
 * catalogue limits. The order of refusal is identity, then a catalogue
 * that is not a positive limit, then output, then context. A missing
 * limit is reported before a shorter one on the same axis.
 */
export const hostCopyMaySubstitute = (input: {
    catalogue: CatalogueLimits;
    host: HostCopyLimits;
}): HostCopyDecision => {
    if (input.host.deploymentId.length === 0) return { ok: false, reason: "blank_deployment" };
    if (input.catalogue.logicalModelId.length === 0 || input.catalogue.logicalModelId !== input.host.logicalModelId) {
        return { ok: false, reason: "different_model" };
    }
    if (!positiveWhole(input.catalogue.maxOutputTokens) || !positiveWhole(input.catalogue.contextTokens)) {
        return { ok: false, reason: "unusable_catalogue" };
    }
    if (input.host.maxOutputTokens === null) return { ok: false, reason: "unproven_output" };
    if (!positiveWhole(input.host.maxOutputTokens)) return { ok: false, reason: "unproven_output" };
    if (input.host.maxOutputTokens < input.catalogue.maxOutputTokens) {
        return { ok: false, reason: "shorter_output" };
    }
    if (input.host.contextTokens === null) return { ok: false, reason: "unproven_context" };
    if (!positiveWhole(input.host.contextTokens)) return { ok: false, reason: "unproven_context" };
    if (input.host.contextTokens < input.catalogue.contextTokens) {
        return { ok: false, reason: "shorter_context" };
    }
    return {
        ok: true,
        logicalModelId: input.catalogue.logicalModelId,
        deploymentId: input.host.deploymentId,
    };
};
