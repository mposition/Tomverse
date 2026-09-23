/**
 * Sticky state and the catalogue score snapshot stay on the logical model
 * id. A deployment-keyed view is derived at read time from bindings the
 * caller already has. Stored conversation columns are not rewritten, and
 * the catalogue snapshot is not rewritten. Nothing here writes a row.
 * The request path does not import this module.
 *
 * A logical cell shared by two deployments is not evidence for either of
 * them. Missing evidence abstains. It does not become a prior.
 */

export const STICKY_GRAIN_REWRITES_STORED_IDS = false;

export type StickyField = "routerModelId" | "routerRecoveryModelId";

export type StickyGrainRefusal = "blank" | "deployment_id" | "ambiguous" | "unknown";

export type StickyGrainResult =
    | {
          ok: true;
          routerModelId: string | null;
          routerRecoveryModelId: string | null;
      }
    | {
          ok: false;
          field: StickyField;
          reason: StickyGrainRefusal;
      };

const classifyStickyId = (
    id: string,
    logicalModelIds: ReadonlySet<string>,
    deploymentIds: ReadonlySet<string>
): "logical" | StickyGrainRefusal => {
    if (id.length === 0) return "blank";
    const logical = logicalModelIds.has(id);
    const deployment = deploymentIds.has(id);
    if (logical && deployment) return "ambiguous";
    if (deployment) return "deployment_id";
    if (logical) return "logical";
    return "unknown";
};

/**
 * Read sticky ids as logical model ids, or refuse.
 *
 * Null is an empty sticky slot. Any other value must be a logical model id
 * exactly as stored: surrounding spaces are not removed, and a deployment
 * id is not translated into the logical model it serves.
 */
export const readStickyAsLogical = (input: {
    routerModelId: string | null;
    routerRecoveryModelId: string | null;
    logicalModelIds: readonly string[];
    deploymentIds: readonly string[];
}): StickyGrainResult => {
    const logical = new Set(input.logicalModelIds);
    const deployments = new Set(input.deploymentIds);
    const fields: readonly StickyField[] = ["routerModelId", "routerRecoveryModelId"];
    for (const field of fields) {
        const id = input[field];
        if (id === null) continue;
        const kind = classifyStickyId(id, logical, deployments);
        if (kind !== "logical") return { ok: false, field, reason: kind };
    }
    return {
        ok: true,
        routerModelId: input.routerModelId,
        routerRecoveryModelId: input.routerRecoveryModelId,
    };
};

export type LogicalScoreEntry = {
    modelId: string;
    providerId: string;
};

export type DeploymentScoreBinding = {
    logicalModelId: string;
    deploymentId: string;
    hasOwnEvidence: boolean;
};

export type DeploymentScoreCell =
    | {
          kind: "deployment";
          logicalModelId: string;
          deploymentId: string;
      }
    | {
          kind: "abstain";
          logicalModelId: string;
          deploymentId: string | null;
          reason: "no_binding" | "shared_without_evidence" | "missing_evidence";
      };

export type ScoreProjection =
    | { ok: false; reason: "blank_model" | "duplicate_logical" | "blank_deployment" | "duplicate_binding" }
    | { ok: true; cells: readonly DeploymentScoreCell[] };

/**
 * Project logical snapshot rows onto deployment keys.
 *
 * The provider named on a logical row is not a deployment. A row with no
 * binding abstains. Two bindings that both lack their own evidence abstain
 * rather than sharing the logical cell. A binding with its own evidence
 * is the only deployment cell.
 */
export const projectDeploymentScores = (input: {
    entries: readonly LogicalScoreEntry[];
    bindings: readonly DeploymentScoreBinding[];
}): ScoreProjection => {
    const seenModels = new Set<string>();
    for (const entry of input.entries) {
        if (entry.modelId.length === 0) return { ok: false, reason: "blank_model" };
        if (seenModels.has(entry.modelId)) return { ok: false, reason: "duplicate_logical" };
        seenModels.add(entry.modelId);
    }

    const seenDeployments = new Set<string>();
    const bindingsByModel = new Map<string, DeploymentScoreBinding[]>();
    for (const binding of input.bindings) {
        if (binding.deploymentId.length === 0 || binding.logicalModelId.length === 0) {
            return { ok: false, reason: "blank_deployment" };
        }
        if (seenDeployments.has(binding.deploymentId)) {
            return { ok: false, reason: "duplicate_binding" };
        }
        seenDeployments.add(binding.deploymentId);
        const list = bindingsByModel.get(binding.logicalModelId) ?? [];
        list.push(binding);
        bindingsByModel.set(binding.logicalModelId, list);
    }

    const cells: DeploymentScoreCell[] = [];
    for (const entry of input.entries) {
        const bindings = bindingsByModel.get(entry.modelId) ?? [];
        if (bindings.length === 0) {
            cells.push({
                kind: "abstain",
                logicalModelId: entry.modelId,
                deploymentId: null,
                reason: "no_binding",
            });
            continue;
        }
        const sharedWithoutEvidence = bindings.length > 1 && bindings.every((binding) => !binding.hasOwnEvidence);
        for (const binding of bindings) {
            if (binding.hasOwnEvidence) {
                cells.push({
                    kind: "deployment",
                    logicalModelId: entry.modelId,
                    deploymentId: binding.deploymentId,
                });
                continue;
            }
            cells.push({
                kind: "abstain",
                logicalModelId: entry.modelId,
                deploymentId: binding.deploymentId,
                reason: sharedWithoutEvidence ? "shared_without_evidence" : "missing_evidence",
            });
        }
    }
    return { ok: true, cells };
};

export type GrainShadowReport =
    | { kind: "match" }
    | { kind: "diverge" }
    | { kind: "inconclusive"; reason: "abstained" | "empty" | "unpaired" };

/**
 * Compare a logical ranking with a deployment ranking.
 *
 * Match, diverge, and inconclusive name the relationship of the two
 * orders. None of them is a selected model. Abstaining, an empty order,
 * or a set that is not one logical model per row is inconclusive: a
 * missing member is not a different ranking of the same set.
 */
export const compareGrainShadow = (input: {
    logicalOrder: readonly string[];
    deploymentOrder: readonly { logicalModelId: string; deploymentId: string }[];
    abstained: boolean;
}): GrainShadowReport => {
    if (input.abstained) return { kind: "inconclusive", reason: "abstained" };
    if (input.logicalOrder.length === 0 || input.deploymentOrder.length === 0) {
        return { kind: "inconclusive", reason: "empty" };
    }

    const logicalSeen = new Set<string>();
    for (const modelId of input.logicalOrder) {
        if (modelId.length === 0 || logicalSeen.has(modelId)) {
            return { kind: "inconclusive", reason: "unpaired" };
        }
        logicalSeen.add(modelId);
    }

    const deploymentSeen = new Set<string>();
    const deploymentModels: string[] = [];
    for (const row of input.deploymentOrder) {
        if (row.logicalModelId.length === 0 || row.deploymentId.length === 0) {
            return { kind: "inconclusive", reason: "unpaired" };
        }
        if (deploymentSeen.has(row.deploymentId) || deploymentModels.includes(row.logicalModelId)) {
            return { kind: "inconclusive", reason: "unpaired" };
        }
        deploymentSeen.add(row.deploymentId);
        deploymentModels.push(row.logicalModelId);
    }

    if (deploymentModels.length !== input.logicalOrder.length) {
        return { kind: "inconclusive", reason: "unpaired" };
    }
    const sameMembers =
        deploymentModels.every((modelId) => logicalSeen.has(modelId)) &&
        input.logicalOrder.every((modelId) => deploymentModels.includes(modelId));
    if (!sameMembers) return { kind: "inconclusive", reason: "unpaired" };

    const sameOrder = deploymentModels.every((modelId, index) => modelId === input.logicalOrder[index]);
    return sameOrder ? { kind: "match" } : { kind: "diverge" };
};
