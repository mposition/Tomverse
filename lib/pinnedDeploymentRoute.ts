/**
 * The chat route's entrance to one stored deployment.
 *
 * A result other than `existing` is the whole response. The ordinary handler
 * does not run afterwards, and this file does not call it. Streaming reuses
 * `streamText` with retries forced off. The text stream is the SDK stream;
 * it is not the chat event stream, and this path does not reserve user credits.
 */

import "server-only";

import { streamText } from "ai";

import { getActiveAiModel } from "@/lib/activeAiModel";
import { getUserChatUsageKey } from "@/lib/chatSecurity";
import { AVAILABLE_MODELS } from "@/lib/models";
import { resolveModelPricing } from "@/lib/modelPricing";
import {
    closePinnedExperiment,
    reservePinnedExperiment,
    type ExperimentDb,
} from "@/lib/pinnedDeploymentBudget";
import {
    pinnedInferenceArguments,
    runPinnedDeployment,
    settlePinnedUsageCost,
    type ExperimentLedger,
    type PinnedRunResult,
} from "@/lib/pinnedDeploymentExecution";
import {
    matchLivePlacement,
    readStoredPlacement,
    type PlacementDb,
} from "@/lib/pinnedDeploymentPlacement";
import { prisma } from "@/lib/prisma";
import {
    authoriseDispatch,
    beginInstrumentedDispatch,
} from "@/lib/routingDispatchInstrumentation";

const experimentDb = prisma as unknown as ExperimentDb;
const placementDb = prisma as unknown as PlacementDb;

const ledger = (): ExperimentLedger => ({
    reserve: (input) => reservePinnedExperiment(experimentDb, input),
    close: (input) => closePinnedExperiment(experimentDb, input),
    snapshot: () => ({ spentMicroUsd: 0, reservedMicroUsd: 0, holds: [] }),
});

const catalogueModel = (logicalModelId: string) =>
    AVAILABLE_MODELS.find((model) => model.id === logicalModelId && model.enabled) ?? null;

export const enterPinnedDeploymentChat = async (input: {
    authenticatedAccountId: string | null;
    traceId: string;
    messages: readonly object[];
    webSearchMode?: string | null;
    deepResearchDepth?: unknown;
    env?: {
        PINNED_DEPLOYMENT_EXECUTION?: string;
        PINNED_DEPLOYMENT_ACCOUNT_ID?: string;
        PINNED_DEPLOYMENT_ID?: string;
        PINNED_DEPLOYMENT_EXPERIMENT_ID?: string;
    };
}): Promise<PinnedRunResult> => {
    const experiment = ledger();
    return runPinnedDeployment({
        env: input.env ?? process.env,
        authenticatedAccountId: input.authenticatedAccountId,
        messages: input.messages,
        webSearchMode: input.webSearchMode,
        deepResearchDepth: input.deepResearchDepth,
    }, {
        loadDeployment: async (deploymentId) => {
            const stored = await readStoredPlacement(placementDb, deploymentId);
            if (!stored || stored.deploymentId !== deploymentId) {
                return { ok: false, reason: "deployment_mismatch" };
            }
            const matched = matchLivePlacement(stored.claim);
            if (!matched.ok) return { ok: false, reason: "deployment_mismatch" };
            return {
                ok: true,
                deploymentId: stored.deploymentId,
                logicalModelId: matched.logicalModelId,
                provider: matched.provider,
                contextWindowTokens: matched.contextWindowTokens,
            };
        },
        resolvePricing: async (logicalModelId) => {
            const model = catalogueModel(logicalModelId);
            if (!model) return null;
            const pricing = resolveModelPricing(model);
            return {
                costSource: pricing.costSource,
                reasoningTokenBilling: pricing.reasoningTokenBilling,
                inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
                outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
                cacheWriteUsdPerMillionTokens: pricing.cacheWriteUsdPerMillionTokens,
                maxOutputTokens: pricing.maxOutputTokens,
            };
        },
        ledger: experiment,
        record: async (plan) => {
            if (!input.authenticatedAccountId) return { ok: false };
            try {
                const account = await prisma.user.findUnique({
                    where: { id: input.authenticatedAccountId },
                    select: { plan: true },
                });
                if (!account) return { ok: false };
                const manifestMessages = plan.messages.map((message) => ({
                    role: message.role,
                    parts: [{ type: "text" as const, text: message.text }],
                }));
                const draft = await beginInstrumentedDispatch({
                    traceId: input.traceId,
                    routerDecision: null,
                    userId: input.authenticatedAccountId,
                    subjectKey: getUserChatUsageKey(input.authenticatedAccountId),
                    plan: account.plan,
                    modelId: plan.logicalModelId,
                    provider: plan.provider,
                    messages: manifestMessages,
                    tokenizerVersion: plan.tokenizerVersion,
                    tokenCount: plan.reservedInputTokens,
                    contextWindowTokens: plan.contextWindowTokens,
                    estimatedInputTokens: plan.estimatedInputTokens,
                    reservedInputTokens: plan.reservedInputTokens,
                    requestOutputCapTokens: plan.maxOutputTokens,
                    reservationId: null,
                    conversationId: null,
                    productKey: null,
                });
                if (!draft) return { ok: false };
                const authorised = await authoriseDispatch(draft, {
                    modelId: plan.logicalModelId,
                    provider: plan.provider,
                    maxOutputTokens: plan.maxOutputTokens,
                    settings: {},
                    messages: manifestMessages,
                    plannerVersion: "none",
                    adapterVersion: "vercel-ai-sdk-streamText-v1",
                });
                if (!authorised) return { ok: false };
                return { ok: true, attemptId: authorised.attemptId };
            } catch {
                return { ok: false };
            }
        },
        transport: async (args) => {
            const model = catalogueModel(args.logicalModelId);
            if (!model) return { started: false };
            let active;
            try {
                active = getActiveAiModel(model);
            } catch {
                return { started: false };
            }
            const inference = pinnedInferenceArguments(args);
            const result = streamText({
                model: active,
                messages: args.messages.map((message) => ({
                    role: message.role,
                    content: message.text,
                })),
                maxOutputTokens: inference.maxOutputTokens,
                maxRetries: inference.maxRetries,
                onFinish: async (event) => {
                    const usage = event.usage;
                    const actual = settlePinnedUsageCost(args, {
                        inputTokens: usage?.inputTokens,
                        outputTokens: usage?.outputTokens,
                        cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens,
                    });
                    await experiment.close(actual === null
                        ? { holdId: args.holdId, experimentId: args.experimentId, outcome: "unknown" }
                        : {
                            holdId: args.holdId,
                            experimentId: args.experimentId,
                            outcome: "usage",
                            actualMicroUsd: actual,
                        });
                },
                onError: async () => {
                    await experiment.close({
                        holdId: args.holdId,
                        experimentId: args.experimentId,
                        outcome: "unknown",
                    });
                },
            });
            return {
                started: true,
                pending: true,
                response: result.toTextStreamResponse(),
            };
        },
    });
};
