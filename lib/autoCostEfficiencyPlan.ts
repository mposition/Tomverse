/**
 * The cost-efficiency diagnostic's run plan: the menu a signed-in Chat turn
 * would offer, the shared selection estimate, each model's price identity, and
 * the manifest a run is recorded with -- source, models, guidance, corpus and
 * split, judge rubric, criteria, expected calls and worst-case cost.
 *
 * Pure and provider-free, so the server start and the offline dry-run
 * (scripts/auto-cost-efficiency-dry-run.mjs) build the same plan. A manifest
 * is a plan, not an approval to spend: a paid run still goes through the
 * existing optimizer start, its spending ceilings and its audit entry.
 */
import { createHash } from "node:crypto";
import { autoLlmRouterCandidates, type AutoLlmRouterCandidate } from "@/lib/autoLlmRouterCore";
import { preflightInputEstimate } from "@/lib/autoDispatchPreflight";
import { resolveModelPricing } from "@/lib/modelPricing";
import type { AiModel, ModelTier } from "@/lib/models";
import { decideRouterModel } from "@/lib/routerDecision";
import { estimateRequestCredits } from "@/lib/webSearchCredits";
import type { WebSearchBackendReadiness } from "@/lib/webSearchBackends";
import {
    AUTO_ROUTER_ANSWER_ATTEMPTS,
    AUTO_ROUTER_QUALITY_JUDGE_ANSWER_MAX_CHARS,
    COST_EFFICIENCY_OBJECTIVE,
    optimizerAnswerOutputTokens,
    type OptimizerDecision,
} from "@/lib/autoRouterOptimizerCore";
import type { CostEfficiencyCriteria } from "@/lib/autoCostEfficiencyReport";

export const COST_EFFICIENCY_PLAN_VERSION = "auto-cost-efficiency-plan-v1";
/**
 * The one output length every candidate is estimated at when the challenger
 * is chosen, so two models are compared under the same assumption. A
 * selection estimate only: it does not model reasoning tokens, and the
 * answer's own usage is what the report measures.
 */
export const COST_EFFICIENCY_ESTIMATE_OUTPUT_TOKENS = 1_000;

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

type RuntimeSignals = Parameters<typeof decideRouterModel>[0]["signals"];

/**
 * The Auto candidates a signed-in account's turn would get for a message (the
 * same decision, credit estimate and file context selectAutoModel uses).
 * Shared by the optimizer's synthetic menus and the offline dry-run.
 */
export const buildAutoCandidateMenu = (input: {
    models: readonly AiModel[];
    plan: ModelTier;
    requestedModelId: string;
    searchBackendReadiness: WebSearchBackendReadiness;
    unhealthyModelIds: ReadonlySet<string> | readonly string[] | undefined;
    signals: RuntimeSignals;
}) => {
    const models = input.models.filter((model) => model.enabled && !model.catalogDeleted);
    const requested = models.find((model) => model.id === input.requestedModelId) ?? models[0];
    const requestOutputCapTokens = requested ? resolveModelPricing(requested).maxOutputTokens : 0;
    return (text: string): AutoLlmRouterCandidate[] => {
        const reservedInputTokens = preflightInputEstimate([{ role: "user", content: text }]).estimatedInputTokens;
        const decision = decideRouterModel({
            text,
            attachments: [],
            webSearchRequested: false,
            searchBackendReadiness: input.searchBackendReadiness,
            models,
            plan: input.plan,
            reservedInputTokens,
            requestOutputCapTokens,
            unhealthyModelIds: input.unhealthyModelIds as Parameters<typeof decideRouterModel>[0]["unhealthyModelIds"],
            signals: input.signals,
            sticky: null,
        });
        const estimate = estimateRequestCredits({
            models,
            estimatedInputTokens: reservedInputTokens,
            webSearchMode: "off",
            backendReadiness: input.searchBackendReadiness,
        });
        return autoLlmRouterCandidates(
            decision.record.eligibleModelIds,
            models,
            Object.fromEntries(estimate.models.map((model) => [model.modelId, model.totalCredits])),
            // Synthetic menus represent saved, signed-in Chat turns without search.
            { isAuthenticated: true, canPersist: true, webSearchRequested: false }
        );
    };
};

/** Null when the price is unresolved or unverified fallback pricing: never zero. */
export const estimateAnswerMicroUsd = (model: AiModel | undefined, decision: Pick<OptimizerDecision, "routerInput" | "routerContext">) => {
    if (!model) return null;
    try {
        const content = decision.routerContext ? `${decision.routerContext}\n${decision.routerInput}` : decision.routerInput;
        const inputTokens = preflightInputEstimate([{ role: "user", content }]).estimatedInputTokens;
        const pricing = resolveModelPricing(model, { estimatedPromptTokens: inputTokens });
        if (pricing.isFallbackPricing) return null;
        const value = Math.ceil(inputTokens * pricing.inputUsdPerMillionTokens +
            COST_EFFICIENCY_ESTIMATE_OUTPUT_TOKENS * pricing.outputUsdPerMillionTokens);
        return Number.isFinite(value) && value >= 0 ? value : null;
    } catch {
        return null;
    }
};

/** The identity a result is tied to: never renamed afterwards, an id that points elsewhere stays visible. */
export const modelIdentity = (model: AiModel, at?: number) => {
    try {
        const pricing = resolveModelPricing(model, at === undefined ? undefined : { at });
        return {
            modelId: model.id, provider: model.provider, apiModel: model.apiModel,
            pricingApiModelId: pricing.apiModelId, reasoning: model.reasoning ?? null,
            pricingVersion: pricing.pricingVersion, costSource: pricing.costSource,
            isFallbackPricing: pricing.isFallbackPricing,
            inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
            outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
            cachedInputPriceMultiplier: pricing.cachedInputPriceMultiplier,
            cacheWriteUsdPerMillionTokens: pricing.cacheWriteUsdPerMillionTokens ?? null,
            maxOutputTokens: pricing.maxOutputTokens,
        };
    } catch {
        return { modelId: model.id, provider: model.provider, apiModel: model.apiModel, pricingApiModelId: null,
            reasoning: model.reasoning ?? null, pricingVersion: null, unpriced: true as const };
    }
};

/** Upper bounds a call can reach; tokens are bounded by characters, which no tokenizer exceeds in practice. */
const JUDGE_SYSTEM_TOKENS = 1_000;
const JUDGE_OUTPUT_TOKENS = 2_000;
const ROUTE_INPUT_TOKENS = 12_000;
const ROUTE_OUTPUT_TOKENS = 1_000;
const GENERATE_INPUT_TOKENS = 60_000;
const GENERATE_OUTPUT_TOKENS = 10_000;
const SYNTHESIZE_OUTPUT_TOKENS = 8_000;
const MESSAGE_BOUND_CHARS = 4_000 + 600;

type Rates = { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number };
const callCost = (rates: Rates | null, inputTokens: number, outputTokens: number) =>
    rates ? Math.ceil(inputTokens * rates.inputUsdPerMillionTokens + outputTokens * rates.outputUsdPerMillionTokens) : null;

/**
 * The most calls one diagnostic cycle can start, and what they could cost at
 * worst: every answer retried, nothing reused between the direct and the
 * replay comparison, the dearest answering model on the menu each time. The
 * binding limit stays the existing actual-spend run ceiling; this is what a
 * reader checks a run against before it starts.
 */
export const costEfficiencyCallPlan = (input: {
    evaluate: number;
    trainRoutes: number;
    synthesize: boolean;
    optimizer: Rates | null;
    router: Rates | null;
    answerModels: readonly AiModel[];
}) => {
    const n = input.evaluate;
    const calls = {
        synthesize: input.synthesize ? 1 : 0,
        generate: 1,
        route: input.trainRoutes + 2 * n,
        answer: 2 * n * AUTO_ROUTER_ANSWER_ATTEMPTS * 2,
        judge: 2 * n * 2,
    };
    const answerCosts = input.answerModels.map((model) => {
        try {
            const pricing = resolveModelPricing(model, { estimatedPromptTokens: MESSAGE_BOUND_CHARS });
            return callCost(pricing, MESSAGE_BOUND_CHARS, optimizerAnswerOutputTokens(model, pricing));
        } catch {
            return null;
        }
    });
    const dearestAnswer = answerCosts.some((value) => value === null) ? null : Math.max(0, ...(answerCosts as number[]));
    const judgeInput = JUDGE_SYSTEM_TOKENS + MESSAGE_BOUND_CHARS + 2 * AUTO_ROUTER_QUALITY_JUDGE_ANSWER_MAX_CHARS;
    const parts = {
        synthesize: calls.synthesize ? callCost(input.optimizer, 2_000, SYNTHESIZE_OUTPUT_TOKENS) : 0,
        generate: callCost(input.optimizer, GENERATE_INPUT_TOKENS, GENERATE_OUTPUT_TOKENS),
        route: callCost(input.router, ROUTE_INPUT_TOKENS * calls.route, ROUTE_OUTPUT_TOKENS * calls.route),
        answer: dearestAnswer === null ? null : dearestAnswer * calls.answer,
        judge: callCost(input.optimizer, judgeInput * calls.judge, JUDGE_OUTPUT_TOKENS * calls.judge),
    };
    const values = Object.values(parts);
    return {
        calls,
        totalCalls: Object.values(calls).reduce((sum, value) => sum + value, 0),
        worstCaseMicroUsd: values.some((value) => value === null) ? null : (values as number[]).reduce((sum, value) => sum + value, 0),
        worstCaseByKind: parts,
        assumptions: {
            answerInputTokens: MESSAGE_BOUND_CHARS, judgeInputTokens: judgeInput, judgeOutputTokens: JUDGE_OUTPUT_TOKENS,
            routeInputTokens: ROUTE_INPUT_TOKENS, routeOutputTokens: ROUTE_OUTPUT_TOKENS,
            generateTokens: [GENERATE_INPUT_TOKENS, GENERATE_OUTPUT_TOKENS], answerAttempts: AUTO_ROUTER_ANSWER_ATTEMPTS,
            reuseBetweenPhases: "none_assumed",
        },
    };
};

export const buildCostEfficiencyManifest = (input: {
    createdAt: string;
    source: { commit: string | null; dirty: boolean | null; files?: Record<string, string> };
    execution: "mock" | "live";
    location: string;
    baselineGuidance: string;
    optimizerModel: AiModel | null;
    routerModel: AiModel | null;
    answerModels: readonly AiModel[];
    /** Train/evaluate counts are null when the sample is drawn at run time. */
    corpus: { source: string; cases: number; train: number | null; evaluate: number | null; split: string; families: { train: number | null; evaluate: number | null }; digest?: string };
    criteria: CostEfficiencyCriteria;
    plan: ReturnType<typeof costEfficiencyCallPlan>;
    runCapMicroUsd: number;
    resultLocation: string;
}) => {
    const at = Date.parse(input.createdAt);
    return {
        version: COST_EFFICIENCY_PLAN_VERSION,
        objective: COST_EFFICIENCY_OBJECTIVE,
        createdAt: input.createdAt,
        execution: input.execution,
        location: input.location,
        source: input.source,
        baseline: { guidanceDigest: digest(input.baselineGuidance), chars: input.baselineGuidance.length },
        candidateGuidance: "generated once from training decisions and pre-cycle statistics, frozen before any holdout call",
        holdout: { currentResultsEnterGenerator: false, priorComparisonsUsed: false },
        models: {
            optimizerAndJudge: input.optimizerModel ? modelIdentity(input.optimizerModel, at) : null,
            router: input.routerModel ? modelIdentity(input.routerModel, at) : null,
            answering: input.answerModels.map((model) => modelIdentity(model, at)),
        },
        allowedProviders: [...new Set([input.optimizerModel, input.routerModel, ...input.answerModels]
            .flatMap((model) => (model ? [model.provider] : [])))].sort(),
        corpus: input.corpus,
        judge: {
            rubric: COST_EFFICIENCY_OBJECTIVE.judgeRubric, orders: 2, priceBlind: true, modelNamesHidden: true,
            answerMaxChars: AUTO_ROUTER_QUALITY_JUDGE_ANSWER_MAX_CHARS, exactGrader: "router-development-exact-json-v1 where a case has an expected answer",
        },
        candidatePolicy: {
            id: COST_EFFICIENCY_OBJECTIVE.candidatePolicy,
            order: ["lower_credit", "lower_estimated_provider_cost", "quality_comparison"],
            estimateOutputTokens: COST_EFFICIENCY_ESTIMATE_OUTPUT_TOKENS,
            unpricedEstimate: "never_zero",
        },
        criteria: input.criteria,
        criteriaDigest: digest(JSON.stringify(input.criteria)),
        plan: input.plan,
        stop: {
            runCapMicroUsd: input.runCapMicroUsd,
            unknownCost: "stop_scheduling_and_drain_in_flight",
            inFlightOvershoot: "accepted_existing_contract",
        },
        promotion: "refused_diagnostic_only",
        resultLocation: input.resultLocation,
        scope: "tool-free text answers; search, attachments, files, Memory and continuation are not measured",
    };
};
export type CostEfficiencyManifest = ReturnType<typeof buildCostEfficiencyManifest>;
