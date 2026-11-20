import "server-only";

import { generateText, jsonSchema, Output } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { getActiveAiModel } from "@/lib/activeAiModel";
import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import {
    CODING_ROUTER_GENERATOR_SYSTEM,
    CODING_ROUTER_JUDGE_SYSTEM,
    CODING_ROUTER_SYNTHESIZER_SYSTEM,
    CODING_TASK_EVAL_BUDGET_SHARE,
    CODING_TASK_EVAL_DEADLINE_MS,
    codingGeneratorEvidence,
    codingTaskEvalRunnerIsolated,
    withTaskEvaluationCost,
    type CodingTaskEvidence,
    type TaskEvaluationCall,
} from "@/lib/autoCodingRouterOptimizerCore";
import { callAutoLlmRouter } from "@/lib/autoLlmRouter";
import {
    AUTO_LLM_ROUTER_MAX_OUTPUT_TOKENS,
    AUTO_LLM_ROUTER_REPLAY_TIMEOUT_MS,
    autoLlmRouterCandidates,
    autoLlmRouterWorstCaseMicroUsd,
    resolveAutoLlmRouterModel,
    type AutoLlmRouterCandidate,
    type CodingRouterContext,
} from "@/lib/autoLlmRouterCore";
import {
    DEFAULT_ROUTER_CODING_GUIDANCE,
    readActiveRouterGuidance,
    writeActiveRouterGuidance,
} from "@/lib/autoLlmRouterGuidance";
import { readAutoLlmRouterModelId } from "@/lib/autoLlmRouterSettings";
import { observeOptimizerCost, optimizerCostFields } from "@/lib/autoOptimizerCost";
import {
    OPTIMIZER_LOCK,
    finishOptimizerCycle,
    optimizerCatalogueIds,
    optimizerJudgeCall,
    pricesOf,
    readOptimizerModelId,
    reserveOptimizerCycle,
    type OptimizerActor,
    type OptimizerStartRefusal,
    type Prices,
} from "@/lib/autoRouterOptimizer";
import {
    autoRouterGeneratorSchema,
    autoRouterSynthesizerSchema,
    guidanceRejection,
    optimizerAnswerOptions,
    optimizerCallFailureDetail,
    optimizerCycleView,
    optimizerPromotionEligibility,
    optimizerVerificationSummary,
    parseJudgeWinner,
    promotedRouterGuidance,
    rolledBackRouterGuidance,
    runOptimizerCycle,
    syntheticCaseViews,
    traceOptimizerCall,
    type OptimizerCallKind,
    type OptimizerPromotionRefusal,
    type OptimizerRunOutcome,
    type SyntheticCaseView,
} from "@/lib/autoRouterOptimizerCore";
import { writeAutoRouterOptimizerSystemAudit } from "@/lib/autoRouterOptimizerSystemAudit";
import { estimateTextTokens } from "@/lib/chatTokenEstimate";
import { runCodingEval } from "@/lib/codingTaskEval";
import {
    CODING_EVAL_LIMITS,
    CODING_EVAL_TASKS,
    codingEvalWorstCaseTokens,
    summarizeCodingEval,
    type CodingEvalResult,
} from "@/lib/codingTaskEvalCore";
import { externalApiRunnableModels } from "@/lib/externalApiCatalog";
import { readCodingRoutingReport } from "@/lib/externalApiRoutingReport";
import { getRuntimeModels } from "@/lib/modelRegistry";
import type { AiModel } from "@/lib/models";
import { prisma } from "@/lib/prisma";

/**
 * The coding router optimizer (lib/autoCodingRouterOptimizerCore.ts): one
 * cycle improves the external API's coding guidance the way a Chat cycle
 * improves Chat's, with the same optimizer and router models, the same one
 * running cycle at a time and the same day and month caps
 * (reserveOptimizerCycle, target "coding"), the same recording and provider
 * spend (finishOptimizerCycle) and the same audit.
 *
 * A cycle first spends up to CODING_TASK_EVAL_BUDGET_SHARE of its budget on
 * the task evaluation (lib/codingTaskEval.ts): for each fixed task, the
 * current coding guidance routes it, and its pick and the next candidate up
 * work the task in a sandbox against hidden tests. Those results and the live
 * coding routing report (counts only) go to the generator as pre-cycle
 * evidence. The rest of the budget runs the shared cycle on synthetic coding
 * requests. Apex candidates are left out of a cycle's menu: one apex answer
 * costs about what the rest of a cycle does.
 *
 * Paid. Off unless the owner turns its daily run on in Admin › Routing
 * (AUTO_CODING_OPTIMIZER_AUTOMATION_SETTING_KEY, default off), or a person
 * starts one there. Promotion is a person's click unless auto-promote is on.
 */

export const AUTO_CODING_OPTIMIZER_AUTOMATION_SETTING_KEY = "auto.llmRouterCodingOptimizerAutomation";

export type CodingOptimizerAutomation = { daily: boolean; autoPromote: boolean };

const GENERATOR_MAX_OUTPUT_TOKENS = 10_000;
const GENERATOR_TIMEOUT_MS = 150_000;
const SYNTHESIZER_MAX_OUTPUT_TOKENS = 12_000;
const SYNTHESIZER_TIMEOUT_MS = 150_000;
/**
 * The task evaluation's limits inside a cycle: the fixed tasks are a few
 * hundred bytes, so a 32 KB workspace and 32 KB of tool output leave ample
 * room while keeping a run's worst case (codingEvalWorstCaseTokens, bytes as
 * an upper bound on tokens) near a million input tokens rather than six.
 */
const CYCLE_EVAL_LIMITS = { ...CODING_EVAL_LIMITS, maxWorkspaceBytes: 32 * 1024, maxToolOutputBytes: 32 * 1024, maxSteps: 8 };

/** More than the router's fixed coding head, guidance and tail, in bytes. */
const ROUTER_INSTRUCTIONS_BOUND_BYTES = 32 * 1024;

/** The live routing report the generator reads. */
const LIVE_ROUTING_DAYS = 7;

export async function readCodingOptimizerAutomation(
    db: Pick<Prisma.TransactionClient, "appSetting"> = prisma
): Promise<CodingOptimizerAutomation> {
    try {
        const row = await db.appSetting.findUnique({
            where: { key: AUTO_CODING_OPTIMIZER_AUTOMATION_SETTING_KEY },
            select: { value: true },
        });
        const value = row ? (JSON.parse(row.value) as Partial<CodingOptimizerAutomation>) : null;
        return { daily: value?.daily === true, autoPromote: value?.autoPromote === true };
    } catch {
        return { daily: false, autoPromote: false };
    }
}

async function writeCodingOptimizerAutomation(tx: Prisma.TransactionClient, value: CodingOptimizerAutomation) {
    if (!value.daily && !value.autoPromote) {
        await tx.appSetting.deleteMany({ where: { key: AUTO_CODING_OPTIMIZER_AUTOMATION_SETTING_KEY } });
        return;
    }
    const stored = JSON.stringify({ daily: value.daily, autoPromote: value.autoPromote });
    await tx.appSetting.upsert({
        where: { key: AUTO_CODING_OPTIMIZER_AUTOMATION_SETTING_KEY },
        create: { key: AUTO_CODING_OPTIMIZER_AUTOMATION_SETTING_KEY, value: stored },
        update: { value: stored },
    });
}

/**
 * The coding cycle's menu: the external API's Smart Adaptive candidates for
 * the widest plan, without apex, each at its per-request credits -- the same
 * candidates and credits the live coding router sees. The menu does not
 * depend on the request text (a synthetic request carries no image or size
 * the external API would filter on).
 */
async function codingCandidateMenu(models: readonly AiModel[]) {
    const runnable = (await externalApiRunnableModels("Max", { smartAdaptive: true })).filter(
        (entry) => entry.model.usageClass !== "apex"
    );
    const candidates = autoLlmRouterCandidates(
        runnable.map((entry) => entry.model.id),
        models,
        Object.fromEntries(runnable.map((entry) => [entry.model.id, entry.capabilities.creditWeight]))
    );
    return (): AutoLlmRouterCandidate[] => candidates;
}

/** A synthetic request's coding signals: a fresh conversation, nothing run yet. */
const syntheticCoding = (text: string): CodingRouterContext => ({
    client: "synthetic",
    toolCount: 0,
    modelTurns: 0,
    inputTokens: estimateTextTokens(text),
    lastToolResult: null,
    currentModelId: null,
});

/** The next candidate up in credits from `pickId`, the cheapest such by id. */
const nextUp = (candidates: readonly AutoLlmRouterCandidate[], pickId: string) => {
    const pick = candidates.find((candidate) => candidate.id === pickId);
    if (!pick || pick.credits === null) return null;
    const above = candidates
        .filter((candidate) => candidate.credits !== null && candidate.credits > pick.credits!)
        .sort((a, b) => a.credits! - b.credits! || a.id.localeCompare(b.id));
    return above[0]?.id ?? null;
};

const costMicroUsd = (prices: Prices, usage: { inputTokens?: number; outputTokens?: number }) =>
    Math.ceil((usage.inputTokens ?? 0) * prices.inputUsdPerMillionTokens + (usage.outputTokens ?? 0) * prices.outputUsdPerMillionTokens);

/** Starts one coding cycle; refusals cost nothing. Mirrors startAutoRouterOptimizerCycle. */
export async function startCodingRouterOptimizerCycle(
    actor: OptimizerActor,
    options: { waitForCompletion?: boolean } = {}
): Promise<{ cycleId: string; outcome?: OptimizerRunOutcome } | { refused: OptimizerStartRefusal }> {
    const models = await getRuntimeModels();
    const optimizerModel = resolveAutoLlmRouterModel(models, (await readOptimizerModelId()) ?? undefined);
    if (!optimizerModel) return { refused: "optimizer_off" };
    const routerModel = resolveAutoLlmRouterModel(models, (await readAutoLlmRouterModelId()) ?? undefined);
    if (!routerModel) return { refused: "router_off" };
    const optimizerPrices = pricesOf(optimizerModel);
    const routerPrices = pricesOf(routerModel);
    if (!optimizerPrices || !routerPrices) return { refused: "pricing_unavailable" };

    const active = await readActiveRouterGuidance(prisma, "coding");
    const started = await reserveOptimizerCycle({
        actor,
        optimizerModelId: optimizerModel.id,
        routerModelId: routerModel.id,
        incumbentGuidance: active.guidance,
        target: "coding",
    });
    if ("refused" in started) return started;
    const run = runCodingCycle({
        cycleId: started.cycle.id,
        budgetMicroUsd: started.cycle.budgetMicroUsd,
        incumbentGuidance: active.guidance,
        models,
        optimizerModel,
        routerModel,
        optimizerPrices,
        routerPrices,
    });
    if (!options.waitForCompletion) {
        void run;
        return { cycleId: started.cycle.id };
    }
    return { cycleId: started.cycle.id, outcome: await run };
}

async function runCodingCycle(input: {
    cycleId: string;
    budgetMicroUsd: number;
    incumbentGuidance: string;
    models: readonly AiModel[];
    optimizerModel: AiModel;
    routerModel: AiModel;
    optimizerPrices: Prices;
    routerPrices: Prices;
}): Promise<OptimizerRunOutcome> {
    const traced = <T>(kind: OptimizerCallKind, run: () => Promise<T>, model = kind === "route" ? input.routerModel : input.optimizerModel) =>
        traceOptimizerCall({ event: "auto_coding_optimizer_call_failed", cycleId: input.cycleId, kind, modelId: model.id, provider: model.provider }, run);
    const outputOf = (kind: string, generated: { readonly output: unknown; finishReason: string }): unknown => {
        try {
            return generated.output;
        } catch (error) {
            console.warn(JSON.stringify({ event: "auto_coding_optimizer_output_unparsed", cycleId: input.cycleId, kind, finishReason: generated.finishReason, ...optimizerCallFailureDetail(error) }));
            return null;
        }
    };
    const cost = (prices: Prices, usage: { inputTokens?: number; outputTokens?: number } | undefined) =>
        optimizerCostFields(observeOptimizerCost(usage, prices));
    const answerModels = new Map(input.models.filter((model) => model.enabled && !model.catalogDeleted).map((model) => [model.id, model]));

    // Spend of the task evaluation, by provider, added to the cycle's own.
    const evalSpent = new Map<string, number>();
    let evalTotal = 0;
    const addEvalSpend = (provider: string, microUsd: number) => {
        evalSpent.set(provider, (evalSpent.get(provider) ?? 0) + microUsd);
        evalTotal += microUsd;
    };
    let known = { spentMicroUsd: 0, spentByProvider: new Map<string, number>() as ReadonlyMap<string, number> };

    try {
        const [candidatesFor, catalogueIds, liveRouting] = await Promise.all([
            codingCandidateMenu(input.models),
            optimizerCatalogueIds(),
            readCodingRoutingReport(LIVE_ROUTING_DAYS).catch(() => null),
        ]);
        const routeWith = (guidance: string, text: string, decisionId: string) =>
            callAutoLlmRouter({
                cycleId: input.cycleId,
                decisionId,
                routerModel: input.routerModel,
                guidance,
                prompt: text,
                previousAnswer: null,
                candidates: candidatesFor(),
                session: null,
                timeoutMs: AUTO_LLM_ROUTER_REPLAY_TIMEOUT_MS,
                source: "routing_optimizer",
                coding: syntheticCoding(text),
            });

        // 1. The task evaluation, within its share of the budget, only on an
        // isolated runner (codingTaskEvalRunnerIsolated). Each run starts only
        // when its worst case still fits; a call whose usage is unknown is
        // charged its worst case and leaves the cycle's cost coverage
        // incomplete, so the cycle cannot be promoted on unconfirmed spend.
        const evalBudget = Math.floor(input.budgetMicroUsd * CODING_TASK_EVAL_BUDGET_SHARE);
        const evalDeadline = Date.now() + CODING_TASK_EVAL_DEADLINE_MS;
        const evalResults: CodingEvalResult[] = [];
        const evalCalls: TaskEvaluationCall[] = [];
        const worstRun = codingEvalWorstCaseTokens(CYCLE_EVAL_LIMITS);
        const isolated = codingTaskEvalRunnerIsolated(process.env);
        let evalStop: "runner_not_isolated" | "budget" | "deadline" | "cost_unknown" | null = isolated ? null : "runner_not_isolated";
        for (const task of isolated ? CODING_EVAL_TASKS : []) {
            if (evalStop) break;
            if (Date.now() >= evalDeadline) {
                evalStop = "deadline";
                break;
            }
            // The router call's worst case -- the request with generous room
            // for the fixed instructions, at the call's output ceiling -- must
            // fit before it is made, and is what it costs if its usage is unknown.
            const worstRoute =
                autoLlmRouterWorstCaseMicroUsd({
                    system: " ".repeat(ROUTER_INSTRUCTIONS_BOUND_BYTES),
                    prompt: JSON.stringify(candidatesFor()) + task.prompt,
                    maxOutputTokens: AUTO_LLM_ROUTER_MAX_OUTPUT_TOKENS,
                    ...input.routerPrices,
                }) ?? Number.POSITIVE_INFINITY;
            if (evalTotal + worstRoute > evalBudget) {
                evalStop = "budget";
                break;
            }
            const routed = await routeWith(input.incumbentGuidance, task.prompt, `task-${task.id}`);
            if (routed.usage?.inputTokens === undefined || routed.usage.outputTokens === undefined) {
                // Usage unknown: charged its worst case, and the evaluation stops.
                const worst = worstRoute;
                addEvalSpend(input.routerModel.provider, worst);
                evalCalls.push({ known: false, microUsd: worst });
                evalStop = "cost_unknown";
                break;
            }
            const routerCost = costMicroUsd(input.routerPrices, routed.usage);
            addEvalSpend(input.routerModel.provider, routerCost);
            evalCalls.push({ known: true, microUsd: routerCost });
            const pick = routed.pick?.modelId;
            if (!pick) continue;
            for (const id of [pick, nextUp(candidatesFor(), pick)]) {
                const model = id ? answerModels.get(id) : undefined;
                const prices = model ? pricesOf(model) : null;
                if (!model || !prices) continue;
                const worst = costMicroUsd(prices, worstRun);
                if (evalTotal + worst > evalBudget) {
                    evalStop = "budget";
                    continue;
                }
                if (Date.now() >= evalDeadline) {
                    evalStop = "deadline";
                    break;
                }
                await runCodingEval({
                    tasks: [task],
                    models: [model],
                    limits: CYCLE_EVAL_LIMITS,
                    shouldContinue: () => true,
                    onResult: (result) => {
                        const known = !result.usageUnknown;
                        const microUsd = known ? costMicroUsd(prices, result) : worst;
                        addEvalSpend(model.provider, microUsd);
                        evalCalls.push({ known, microUsd });
                        evalResults.push(result);
                    },
                });
            }
        }
        const taskEvaluation: CodingTaskEvidence[] = summarizeCodingEval(evalResults).map((row) => ({
            modelId: row.modelId,
            tasks: row.tasks,
            passed: row.passed,
            byDifficulty: row.byDifficulty,
        }));
        const evidence = codingGeneratorEvidence({ taskEvaluation, liveRouting });

        // 2. The shared cycle on synthetic coding requests, on what is left.
        const result = await runOptimizerCycle(
            { decisions: [], incumbentGuidance: input.incumbentGuidance, routerStats: null, catalogueIds, unreliableModels: [] },
            {
                budgetMicroUsd: Math.max(0, input.budgetMicroUsd - evalTotal),
                candidatesFor,
                guidanceRejected: (rejection) =>
                    console.warn(JSON.stringify({ event: "auto_coding_optimizer_guidance_rejected", cycleId: input.cycleId, reason: rejection.reason, ids: rejection.ids })),
                synthesize: async (message) => {
                    const generated = await traced("synthesize", () => generateText({
                        model: getActiveAiModel(input.optimizerModel),
                        system: CODING_ROUTER_SYNTHESIZER_SYSTEM,
                        prompt: message,
                        maxOutputTokens: SYNTHESIZER_MAX_OUTPUT_TOKENS,
                        reasoning: "none",
                        maxRetries: 0,
                        abortSignal: AbortSignal.timeout(SYNTHESIZER_TIMEOUT_MS),
                        output: Output.object({ schema: jsonSchema(autoRouterSynthesizerSchema() as unknown as JSONSchema7), name: "coding_router_test_requests" }),
                        providerOptions: { openai: { strictJsonSchema: true } },
                    }));
                    return { value: outputOf("synthesize", generated), ...cost(input.optimizerPrices, generated.usage), provider: input.optimizerModel.provider };
                },
                generate: async (message) => {
                    const generated = await traced("generate", () => generateText({
                        model: getActiveAiModel(input.optimizerModel),
                        system: CODING_ROUTER_GENERATOR_SYSTEM,
                        // The coding cycle's pre-cycle evidence travels after the shared message.
                        prompt: `${message}\n\n${evidence}`,
                        maxOutputTokens: GENERATOR_MAX_OUTPUT_TOKENS,
                        maxRetries: 0,
                        abortSignal: AbortSignal.timeout(GENERATOR_TIMEOUT_MS),
                        output: Output.object({ schema: jsonSchema(autoRouterGeneratorSchema() as unknown as JSONSchema7), name: "coding_router_guidance" }),
                        providerOptions: { openai: { strictJsonSchema: true } },
                    }));
                    const output = outputOf("generate", generated);
                    const rejection = guidanceRejection((output as { guidance?: unknown } | null)?.guidance);
                    if (rejection) console.warn(JSON.stringify({ event: "auto_coding_optimizer_guidance_rejected", cycleId: input.cycleId, ...rejection }));
                    return { value: output, ...cost(input.optimizerPrices, generated.usage), provider: input.optimizerModel.provider };
                },
                route: async (guidance, decision) => {
                    const routed = await routeWith(guidance, decision.routerInput, decision.id);
                    return { value: routed.pick?.modelId ?? null, ...cost(input.routerPrices, routed.usage), provider: input.routerModel.provider };
                },
                answer: async (modelId, turn) => {
                    const model = answerModels.get(modelId);
                    const prices = model ? pricesOf(model) : null;
                    if (!model || !prices) {
                        return { value: null, ...optimizerCostFields({ state: "no_dispatch", reason: !model ? "model_unavailable" : "unpriced" }), provider: model?.provider ?? "unknown" };
                    }
                    const { timeoutMs, ...options } = optimizerAnswerOptions(model, turn);
                    const generated = await traced("answer", () => generateText({ model: getActiveAiModel(model), abortSignal: AbortSignal.timeout(timeoutMs), ...options }), model);
                    return { value: generated.text, ...cost(prices, generated.usage), provider: model.provider };
                },
                judge: async (message) => {
                    const generated = await traced("judge", () => optimizerJudgeCall({ model: input.optimizerModel, system: CODING_ROUTER_JUDGE_SYSTEM, prompt: message, name: "coding_router_judgement" }));
                    return { value: parseJudgeWinner(outputOf("judge", generated)), ...cost(input.optimizerPrices, generated.usage), provider: input.optimizerModel.provider };
                },
            }
        );
        const spentByProvider = new Map(result.spentByProvider);
        for (const [provider, microUsd] of evalSpent) spentByProvider.set(provider, (spentByProvider.get(provider) ?? 0) + microUsd);
        const spentMicroUsd = result.spentMicroUsd + evalTotal;
        known = { spentMicroUsd, spentByProvider };
        const recorded = await finishOptimizerCycle({
            cycleId: input.cycleId,
            data: {
                status: result.status,
                failure: result.failure,
                candidateGuidance: result.candidateGuidance,
                cases: result.cases,
                summary: {
                    ...result.summary,
                    // The task evaluation's calls count in the cycle's cost coverage.
                    ...optimizerVerificationSummary({
                        ...result,
                        costCoverage: withTaskEvaluationCost(result.costCoverage, evalCalls),
                    }),
                    failedCalls: result.failedCalls,
                    failedByKind: result.failedByKind,
                    report: result.report,
                    comparisons: result.comparisons,
                    gate: result.gate,
                    judgeFailed: result.judgeFailed,
                    answerStats: result.answerStats,
                    // The coding cycle's own evidence, content-free.
                    taskEvaluation,
                    taskEvaluationSpentMicroUsd: evalTotal,
                    taskEvaluationStop: evalStop,
                    liveRouting,
                },
                spentMicroUsd,
                finishedAt: new Date(),
            },
            spentByProvider,
        });
        let autoPromoted: boolean | string = false;
        if (recorded && result.status === "passed" && (await readCodingOptimizerAutomation()).autoPromote) {
            const promotion = await promoteCodingRouterOptimizerCycle(input.cycleId, "system").catch(() => ({ refused: "promotion_error" as const }));
            autoPromoted = "ok" in promotion ? true : promotion.refused;
        }
        console.info(JSON.stringify({
            event: "auto_coding_optimizer_cycle",
            cycleId: input.cycleId,
            recorded,
            autoPromoted,
            status: result.status,
            failure: result.failure,
            spentMicroUsd,
            taskEvaluationSpentMicroUsd: evalTotal,
            taskRuns: evalResults.length,
            taskEvaluationStop: evalStop,
            taskPassed: evalResults.filter((item) => item.passed).length,
            decided: result.summary.decided,
            gate: result.gate,
        }));
        return { recorded, status: result.status, failure: result.failure };
    } catch (error) {
        // What is known to be spent goes to the row and the provider buckets:
        // the whole cycle's when it got that far, otherwise the task evaluation's.
        const spent = known.spentMicroUsd > 0 ? known : { spentMicroUsd: evalTotal, spentByProvider: evalSpent };
        console.error(JSON.stringify({
            event: "auto_coding_optimizer_cycle_failed",
            cycleId: input.cycleId,
            error: error instanceof Error ? error.name : "unknown",
            knownSpentMicroUsd: spent.spentMicroUsd,
        }));
        await finishOptimizerCycle({
            cycleId: input.cycleId,
            data: { status: "error", failure: "run_error", spentMicroUsd: spent.spentMicroUsd, finishedAt: new Date() },
            spentByProvider: spent.spentByProvider,
        }).catch(() => undefined);
        return { recorded: false, status: "error", failure: "run_error" };
    }
}

type AdminActor = { session: Session; request: Request };

/** Makes a passed coding cycle's guidance the one the coding router follows. */
export async function promoteCodingRouterOptimizerCycle(
    cycleId: string,
    actor: OptimizerActor
): Promise<{ ok: true } | { refused: "not_found" | "not_passed" | "already_promoted" | "stale" | OptimizerPromotionRefusal }> {
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OPTIMIZER_LOCK}))`;
        const cycle = await tx.autoRouterOptimizerCycle.findUnique({
            where: { id: cycleId },
            select: { status: true, candidateGuidance: true, incumbentGuidance: true, promotedAt: true, target: true, summary: true },
        });
        if (!cycle || cycle.target !== "coding") return { refused: "not_found" as const };
        if (cycle.promotedAt) return { refused: "already_promoted" as const };
        const eligibility = optimizerPromotionEligibility(cycle);
        if (!eligibility.eligible) return { refused: eligibility.refusal };
        const active = await readActiveRouterGuidance(tx, "coding");
        if (active.guidance !== cycle.incumbentGuidance) return { refused: "stale" as const };
        await writeActiveRouterGuidance(tx, promotedRouterGuidance(active, { guidance: cycle.candidateGuidance!, cycleId }), "coding");
        await tx.autoRouterOptimizerCycle.update({ where: { id: cycleId }, data: { promotedAt: new Date() } });
        const entry = {
            action: "auto.llm_router_coding_guidance.promoted" as const,
            targetId: cycleId,
            summary: actor === "system"
                ? "Promoted the coding router guidance automatically from a passed cycle."
                : "Promoted the coding router guidance from an optimizer cycle.",
            metadata: { previousCycleId: active.cycleId },
        };
        if (actor === "system") await writeAutoRouterOptimizerSystemAudit(tx, entry);
        else await writeAdminAuditLog({ ...actor, tx, targetType: "AutoRouterOptimizerCycle", ...entry });
        return { ok: true as const };
    });
}

/** Returns the coding guidance to the one before it (or the code default). */
export async function rollBackCodingRouterGuidance(actor: AdminActor): Promise<{ ok: true } | { refused: "nothing_to_roll_back" }> {
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OPTIMIZER_LOCK}))`;
        const active = await readActiveRouterGuidance(tx, "coding");
        const restored = rolledBackRouterGuidance(active, DEFAULT_ROUTER_CODING_GUIDANCE.guidance);
        if (!restored) return { refused: "nothing_to_roll_back" as const };
        await writeActiveRouterGuidance(tx, restored, "coding");
        await writeAdminAuditLog({
            ...actor,
            tx,
            action: "auto.llm_router_coding_guidance.rolled_back",
            targetType: "AutoRouterOptimizerCycle",
            targetId: active.cycleId,
            summary: "Rolled the coding router guidance back one step.",
            metadata: { restoredCycleId: restored.cycleId },
        });
        return { ok: true as const };
    });
}

export async function updateCodingOptimizerAutomation(actor: AdminActor, after: CodingOptimizerAutomation) {
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        const before = await readCodingOptimizerAutomation(tx);
        await writeCodingOptimizerAutomation(tx, after);
        await writeAdminAuditLog({
            ...actor,
            tx,
            action: "auto.llm_router_coding_optimizer_automation.updated",
            targetType: "AppSettings",
            targetId: AUTO_CODING_OPTIMIZER_AUTOMATION_SETTING_KEY,
            summary: `Set the coding router optimizer automation: daily ${after.daily ? "on" : "off"}, auto-promote ${after.autoPromote ? "on" : "off"}.`,
            metadata: { before, after },
        });
    });
}

export const AUTO_CODING_OPTIMIZER_LISTED_CYCLES = 10;

export type CodingOptimizerCycleView = {
    id: string;
    createdAt: string;
    status: string;
    failure: string | null;
    optimizerModelId: string;
    candidateGuidance: string | null;
    summary: unknown;
    promotionEligibility: ReturnType<typeof optimizerPromotionEligibility>;
    spentMicroUsd: number;
    promotedAt: string | null;
    syntheticCases: SyntheticCaseView[];
};

/** Everything the coding section of Admin shows: no real request text exists to show. */
export async function readCodingRouterOptimizerState() {
    const now = new Date();
    const [optimizerModelId, automation, active, cycles, day, week] = await Promise.all([
        readOptimizerModelId(),
        readCodingOptimizerAutomation(),
        readActiveRouterGuidance(prisma, "coding"),
        prisma.autoRouterOptimizerCycle.findMany({
            where: { target: "coding" },
            orderBy: { createdAt: "desc" },
            take: AUTO_CODING_OPTIMIZER_LISTED_CYCLES,
            select: { id: true, createdAt: true, status: true, failure: true, optimizerModelId: true, candidateGuidance: true, summary: true, spentMicroUsd: true, promotedAt: true, cases: true },
        }),
        readCodingRoutingReport(1, now).catch(() => null),
        readCodingRoutingReport(7, now).catch(() => null),
    ]);
    return {
        optimizerModelId,
        automation,
        listedCycles: AUTO_CODING_OPTIMIZER_LISTED_CYCLES,
        active: { cycleId: active.cycleId, guidance: active.guidance, canRollBack: active.cycleId !== null },
        report: { day, week },
        cycles: cycles.map(({ cases, ...cycle }): CodingOptimizerCycleView => ({
            ...cycle,
            ...optimizerCycleView(cycle, now),
            promotionEligibility: optimizerPromotionEligibility(cycle),
            syntheticCases: syntheticCaseViews(cases),
            createdAt: cycle.createdAt.toISOString(),
            promotedAt: cycle.promotedAt?.toISOString() ?? null,
        })),
    };
}
