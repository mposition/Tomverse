import "server-only";

import type { observePromptRefinerVnextOneShotDeployment } from
    "./promptRefinerQualityEvaluationVnextOneShotDeploymentReadback";
import type { readPromptRefinerVnextOneShotPrice } from
    "./promptRefinerQualityEvaluationVnextOneShotPriceReadback";
import type { verifyPromptRefinerVnextOneShotDevelopmentSource } from
    "./promptRefinerQualityEvaluationVnextOneShotSource";

type Source = Awaited<ReturnType<typeof verifyPromptRefinerVnextOneShotDevelopmentSource>>;
type Deployment = Awaited<ReturnType<typeof observePromptRefinerVnextOneShotDeployment>>;
type Price = Awaited<ReturnType<typeof readPromptRefinerVnextOneShotPrice>>;

const SOURCE_FAILURE_CODES = new Set([
    "vnext_one_shot_source_root_invalid",
    "vnext_one_shot_source_total_size",
    "vnext_one_shot_source_boundary",
    "vnext_one_shot_source_not_regular",
    "vnext_one_shot_source_changed",
    "vnext_one_shot_source_size",
    "vnext_one_shot_source_drift",
    "vnext_one_shot_source_closure_invalid",
    "vnext_one_shot_source_unavailable",
]);
const DEPLOYMENT_FAILURE_CODES = new Set(["railway_deployment_unavailable"]);
const PRICE_FAILURE_CODES = new Set(["vnext_one_shot_price_read_failed"]);

/** Never put a filesystem path or unexpected exception in an API response. */
export function promptRefinerVnextOneShotDevelopmentSourceFailureCode(error: unknown): string {
    return error instanceof Error && SOURCE_FAILURE_CODES.has(error.message)
        ? error.message : "development_source_unavailable";
}

export function promptRefinerVnextOneShotDeploymentFailureCode(error: unknown): string {
    return error instanceof Error && DEPLOYMENT_FAILURE_CODES.has(error.message)
        ? error.message : "deployment_read_unavailable";
}

export function promptRefinerVnextOneShotPriceFailureCode(error: unknown): string {
    return error instanceof Error && PRICE_FAILURE_CODES.has(error.message)
        ? error.message : "price_read_unavailable";
}

/**
 * Content-free owner diagnostic only. In particular, three green development
 * reads are not a final source closure, a durable reservation, or a stage/run
 * approval. Callers cannot turn this result into dispatch authority.
 */
export function summarizePromptRefinerVnextOneShotDevelopmentReadback(input: {
    source: Source | null;
    sourceProblem?: string;
    deployment: Deployment | null;
    deploymentProblem?: string;
    price: Price | null;
    priceProblem?: string;
}) {
    const problems: string[] = [];
    if (!input.source) problems.push(input.sourceProblem && SOURCE_FAILURE_CODES.has(input.sourceProblem)
        ? input.sourceProblem : "development_source_unavailable");
    if (!input.deployment) {
        problems.push(input.deploymentProblem && DEPLOYMENT_FAILURE_CODES.has(input.deploymentProblem)
            ? input.deploymentProblem : "deployment_read_unavailable");
    } else {
        problems.push(...input.deployment.problems);
    }
    if (!input.price) {
        problems.push(input.priceProblem && PRICE_FAILURE_CODES.has(input.priceProblem)
            ? input.priceProblem : "price_read_unavailable");
    } else {
        problems.push(...input.price.problems);
    }
    return Object.freeze({
        developmentSourceVerified: input.source !== null,
        deploymentVerified: input.deployment?.runtimeAndRailwayAgree === true &&
            input.deployment.activeDeploymentConfirmed === true,
        pricePinMatchesRegistry: input.price?.pricePinMatchesRegistry === true,
        problems: Object.freeze(problems),
        finalSourceClosureVerified: false as const,
        reservationVerified: false as const,
        stageApproved: false as const,
        runApproved: false as const,
        dispatchAuthorized: false as const,
    });
}
