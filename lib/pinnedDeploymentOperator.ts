/**
 * The one approved production write for the pinned deployment path.
 *
 * The request path does not import this module and does not read these
 * numbers. A missing flag is a refusal, not a fallback to the amount below.
 * 1000000 micro-USD is the ceiling named on 2026-09-24. US$5 was not named.
 */

import { AVAILABLE_MODELS } from "@/lib/models";
import { PROVIDER_API_CONFIGURATION } from "@/lib/modelRegistryShared";
import {
    matchLivePlacement,
    type LivePlacementClaim,
} from "@/lib/pinnedDeploymentPlacement";

export const PINNED_EXECUTION_APPROVED_LIMIT_MICRO_USD = 1_000_000;
export const PINNED_EXECUTION_APPROVED_TARGET = "production";
export const PINNED_EXECUTION_LOGICAL_MODEL_ID = "gpt-5-6-luna";

const FORBIDDEN_LIFECYCLE_EVENTS = new Set([
    "build",
    "prebuild",
    "postbuild",
    "start",
    "prestart",
    "poststart",
    "deploy",
    "predeploy",
    "postdeploy",
    "db:migrate",
    "postinstall",
]);

const named = (value: string | null | undefined): string | null =>
    typeof value === "string" && value.length > 0 && value === value.trim() ? value : null;

export const parsePinnedExecutionLimit = (value: string | null): number | null => {
    if (!value || !/^[0-9]+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
};

export const approvedLiveClaim = (): LivePlacementClaim | null => {
    const model = AVAILABLE_MODELS.find(
        (entry) => entry.id === PINNED_EXECUTION_LOGICAL_MODEL_ID && entry.enabled
    );
    const endpoint = model ? PROVIDER_API_CONFIGURATION[model.provider] : undefined;
    if (!model || !endpoint) return null;
    const claim: LivePlacementClaim = {
        logicalModelId: model.id,
        gatewayProvider: model.provider,
        servingProvider: model.provider,
        endpointUrl: endpoint.baseUrl,
        upstreamDeploymentName: model.apiModel,
    };
    return matchLivePlacement(claim).ok ? claim : null;
};

export type PinnedExecutionInvocation = {
    apply: boolean;
    approved: boolean;
    limitMicroUsd: number | null;
    target: string | null;
    accountId: string | null;
    ci: boolean;
    lifecycleEvent: string | null;
    railwayDeployment: boolean;
};

export type PinnedExecutionProblem = {
    code:
        | "limit"
        | "target"
        | "account"
        | "approval"
        | "automated";
    message: string;
};

export const pinnedExecutionProblems = (
    invocation: PinnedExecutionInvocation
): PinnedExecutionProblem[] => {
    const problems: PinnedExecutionProblem[] = [];
    if (invocation.limitMicroUsd !== PINNED_EXECUTION_APPROVED_LIMIT_MICRO_USD) {
        problems.push({
            code: "limit",
            message: "The limit must be the approved 1000000 micro-USD ceiling.",
        });
    }
    if (invocation.target !== PINNED_EXECUTION_APPROVED_TARGET) {
        problems.push({
            code: "target",
            message: "The target must be production.",
        });
    }
    if (!named(invocation.accountId)) {
        problems.push({
            code: "account",
            message: "PINNED_DEPLOYMENT_ACCOUNT_ID must be the looked-up account id.",
        });
    }
    if (!invocation.apply) return problems;
    if (!invocation.approved) {
        problems.push({
            code: "approval",
            message: "A write needs --approved-pinned-execution.",
        });
    }
    const lifecycle = invocation.lifecycleEvent?.trim() || "";
    if (
        invocation.ci ||
        invocation.railwayDeployment ||
        FORBIDDEN_LIFECYCLE_EVENTS.has(lifecycle)
    ) {
        problems.push({
            code: "automated",
            message: "A write does not run in CI, a deploy, or a migrate hook.",
        });
    }
    return problems;
};
