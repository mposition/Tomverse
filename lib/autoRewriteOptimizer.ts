import "server-only";

import { generateText, jsonSchema, Output } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { getActiveAiModel } from "@/lib/activeAiModel";
import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { writeAutoRouterOptimizerSystemAudit } from "@/lib/autoRouterOptimizerSystemAudit";
import { callAutoLlmRouter } from "@/lib/autoLlmRouter";
import {
    AUTO_LLM_ROUTER_REPLAY_TIMEOUT_MS,
    resolveAutoLlmRouterModel,
} from "@/lib/autoLlmRouterCore";
import {
    DEFAULT_ROUTER_REWRITE_GUIDANCE,
    readActiveRouterGuidance,
    writeActiveRouterGuidance,
} from "@/lib/autoLlmRouterGuidance";
import { readAutoLlmRouterModelId, readAutoLlmRouterRewrite } from "@/lib/autoLlmRouterSettings";
import {
    OPTIMIZER_LOCK,
    asSession,
    autoCandidateMenu,
    finishOptimizerCycle,
    isCandidate,
    optimizerJudgeCall,
    pricesOf,
    readOptimizerAutomation,
    readOptimizerModelId,
    reserveOptimizerCycle,
    runScheduledAutoRouterOptimizerCycle,
    type OptimizerActor,
    type OptimizerStartRefusal,
    type Prices,
} from "@/lib/autoRouterOptimizer";
import {
    AUTO_ROUTER_OPTIMIZER_SAMPLE_MAX,
    callCostMicroUsd,
    optimizerAnswerOptions,
    optimizerCallFailureDetail,
    optimizerCycleView,
    parseJudgeWinner,
    promotedRouterGuidance,
    rolledBackRouterGuidance,
    guidanceRejection,
    type OptimizerCallKind,
    type OptimizerRunOutcome,
} from "@/lib/autoRouterOptimizerCore";
import {
    AUTO_REWRITE_GENERATOR_SYSTEM,
    AUTO_REWRITE_JUDGE_SYSTEM,
    AUTO_REWRITE_SYNTHESIZER_SYSTEM,
    autoRewriteGeneratorSchema,
    autoRewriteSynthesizerSchema,
    isRewriteSampleTurn,
    rewriteSyntheticCaseViews,
    runRewriteOptimizerCycle,
    scheduledOptimizerTarget,
    type RewriteOptimizerDecision,
    type RewriteSyntheticCaseView,
} from "@/lib/autoRewriteOptimizerCore";
import { getRuntimeModels } from "@/lib/modelRegistry";
import type { AiModel } from "@/lib/models";
import { prisma } from "@/lib/prisma";

/**
 * Runs, promotes and rolls back rewrite guidance cycles (Admin › Routing).
 *
 * The same switches and money as the routing optimizer
 * (lib/autoRouterOptimizer.ts): the optimizer model setting turns it on and
 * approves its calls; a cycle starts through the same reservation, so one
 * cycle of either target runs at a time and both count against the same day
 * and month caps; every provider paid is booked to its own budget. Only what
 * a cycle improves differs: the rewrite guidance (AppSetting
 * `auto.llmRouterRewriteGuidance`), never the routing guidance. A cycle only
 * proposes; a person, or the owner-enabled automatic promotion -- a switch of
 * its own, off by default -- promotes.
 */

/** Its own switches, so turning on the routing automation changes nothing here. */
export const AUTO_REWRITE_OPTIMIZER_AUTOMATION_SETTING_KEY = "auto.llmRouterRewriteOptimizerAutomation";

export type RewriteOptimizerAutomation = { daily: boolean; autoPromote: boolean };

// The routing optimizer's call limits (lib/autoRouterOptimizer.ts), except the
// synthesizer: a two-turn conversation is longer than a single message. The
// judge is the routing optimizer's own call (optimizerJudgeCall), limits and all.
const GENERATOR_MAX_OUTPUT_TOKENS = 6_000;
const GENERATOR_TIMEOUT_MS = 90_000;
const SYNTHESIZER_MAX_OUTPUT_TOKENS = 16_000;
const SYNTHESIZER_TIMEOUT_MS = 180_000;
/** How many times the sample size of recent rewritten turns is read before filtering. */
const SAMPLE_READ_FACTOR = 4;

export async function readRewriteOptimizerAutomation(
    db: Pick<Prisma.TransactionClient, "appSetting"> = prisma
): Promise<RewriteOptimizerAutomation> {
    try {
        const row = await db.appSetting.findUnique({
            where: { key: AUTO_REWRITE_OPTIMIZER_AUTOMATION_SETTING_KEY },
            select: { value: true },
        });
        const value = row ? (JSON.parse(row.value) as Partial<RewriteOptimizerAutomation>) : null;
        return { daily: value?.daily === true, autoPromote: value?.autoPromote === true };
    } catch {
        return { daily: false, autoPromote: false };
    }
}

async function writeRewriteOptimizerAutomation(
    tx: Prisma.TransactionClient,
    value: RewriteOptimizerAutomation
): Promise<void> {
    if (!value.daily && !value.autoPromote) {
        await tx.appSetting.deleteMany({ where: { key: AUTO_REWRITE_OPTIMIZER_AUTOMATION_SETTING_KEY } });
        return;
    }
    const stored = JSON.stringify({ daily: value.daily, autoPromote: value.autoPromote });
    await tx.appSetting.upsert({
        where: { key: AUTO_REWRITE_OPTIMIZER_AUTOMATION_SETTING_KEY },
        create: { key: AUTO_REWRITE_OPTIMIZER_AUTOMATION_SETTING_KEY, value: stored },
        update: { value: stored },
    });
}

/**
 * Recent follow-up turns the live router was asked to rewrite. Asking is what
 * established that the turn had no attachment anywhere and a short enough
 * message (lib/autoLlmRouter.ts); the decision row records neither, so a turn
 * routed with rewriting off is not used. Read deeper than the sample, so a
 * run of turns that do not qualify does not shrink it. Exported for the
 * database test.
 */
export async function loadRewriteDecisions(): Promise<RewriteOptimizerDecision[]> {
    const rows = await prisma.autoRouterDecision.findMany({
        where: { outcome: "picked", version: { contains: "+rewrite" }, routerContext: { not: null } },
        orderBy: { createdAt: "desc" },
        take: AUTO_ROUTER_OPTIMIZER_SAMPLE_MAX * SAMPLE_READ_FACTOR,
        select: {
            id: true,
            routerInput: true,
            routerContext: true,
            routerSession: true,
            candidates: true,
            pickedModelId: true,
        },
    });
    const turns = rows.flatMap((row) => {
        const candidates = Array.isArray(row.candidates) ? row.candidates.filter(isCandidate) : [];
        const turn = { routerInput: row.routerInput, routerContext: row.routerContext, candidates };
        if (!isRewriteSampleTurn(turn) || !row.routerContext) return [];
        return [{
            id: row.id,
            routerInput: row.routerInput,
            routerContext: row.routerContext,
            routerSession: asSession(row.routerSession),
            candidates,
            pickedModelId: row.pickedModelId,
        }];
    });
    return turns.slice(0, AUTO_ROUTER_OPTIMIZER_SAMPLE_MAX);
}

/**
 * Starts one rewrite cycle. By default it returns at once and the calls run
 * in the background (Admin's button); with `waitForCompletion` it returns when
 * the cycle has finished and been recorded, with the outcome (the own-process
 * optimizer service). Refusals cost nothing.
 */
export async function startAutoRewriteOptimizerCycle(
    actor: OptimizerActor,
    options: { waitForCompletion?: boolean } = {}
): Promise<{ cycleId: string; outcome?: OptimizerRunOutcome } | { refused: OptimizerStartRefusal }> {
    const models = await getRuntimeModels();
    const optimizerModel = resolveAutoLlmRouterModel(models, (await readOptimizerModelId()) ?? undefined);
    if (!optimizerModel) return { refused: "optimizer_off" };
    const routerModel = resolveAutoLlmRouterModel(models, (await readAutoLlmRouterModelId()) ?? undefined);
    if (!routerModel) return { refused: "router_off" };

    const decisions = await loadRewriteDecisions();
    const optimizerPrices = pricesOf(optimizerModel);
    const routerPrices = pricesOf(routerModel);
    if (!optimizerPrices || !routerPrices) return { refused: "pricing_unavailable" };

    // The rewrite is measured inside the router prompt as it is live: the
    // routing guidance in force, with each of the two rewrite guidances.
    const [routing, active] = await Promise.all([
        readActiveRouterGuidance(),
        readActiveRouterGuidance(prisma, "rewrite"),
    ]);
    const started = await reserveOptimizerCycle({
        actor,
        optimizerModelId: optimizerModel.id,
        routerModelId: routerModel.id,
        incumbentGuidance: active.guidance,
        target: "rewrite",
    });
    if ("refused" in started) return started;

    const run = runInBackground({
        cycleId: started.cycle.id,
        budgetMicroUsd: started.cycle.budgetMicroUsd,
        decisions,
        routingGuidance: routing.guidance,
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

/** Runs a reserved rewrite cycle and records it; never throws (as the routing one). */
async function runInBackground(input: {
    cycleId: string;
    budgetMicroUsd: number;
    decisions: RewriteOptimizerDecision[];
    routingGuidance: string;
    incumbentGuidance: string;
    models: readonly AiModel[];
    optimizerModel: AiModel;
    routerModel: AiModel;
    optimizerPrices: Prices;
    routerPrices: Prices;
}): Promise<OptimizerRunOutcome> {
    // As in the routing cycle: a failed call is logged by shape and rethrown
    // (it then costs nothing in the cycle's count); content never reaches a log.
    const traced = async <T>(kind: OptimizerCallKind, run: () => Promise<T>) => {
        try {
            return await run();
        } catch (error) {
            console.warn(JSON.stringify({
                event: "auto_rewrite_optimizer_call_failed",
                cycleId: input.cycleId,
                kind,
                ...optimizerCallFailureDetail(error),
            }));
            throw error;
        }
    };
    // An output that does not parse was still paid for: it reads as null and
    // the cost stays counted.
    const outputOf = (
        kind: "synthesize" | "generate" | "judge",
        generated: { readonly output: unknown; finishReason: string; usage?: { outputTokens?: number } }
    ): unknown => {
        try {
            return generated.output;
        } catch (error) {
            console.warn(JSON.stringify({
                event: "auto_rewrite_optimizer_output_unparsed",
                cycleId: input.cycleId,
                kind,
                finishReason: generated.finishReason,
                outputTokens: generated.usage?.outputTokens ?? null,
                ...optimizerCallFailureDetail(error),
            }));
            return null;
        }
    };
    const cost = (prices: Prices, usage: { inputTokens?: number; outputTokens?: number } | undefined) =>
        callCostMicroUsd({ inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, ...prices });
    const answerModels = new Map(
        input.models
            .filter((model) => model.enabled && !model.catalogDeleted)
            .map((model) => [model.id, model])
    );
    let known: { spentMicroUsd: number; spentByProvider: ReadonlyMap<string, number> } = {
        spentMicroUsd: 0,
        spentByProvider: new Map(),
    };
    try {
        const candidatesFor = await autoCandidateMenu(input.models);
        const result = await runRewriteOptimizerCycle(
            { decisions: input.decisions, incumbentGuidance: input.incumbentGuidance },
            {
                budgetMicroUsd: input.budgetMicroUsd,
                candidatesFor,
                synthesize: async (message) => {
                    const generated = await traced("synthesize", () => generateText({
                        model: getActiveAiModel(input.optimizerModel),
                        system: AUTO_REWRITE_SYNTHESIZER_SYSTEM,
                        prompt: message,
                        maxOutputTokens: SYNTHESIZER_MAX_OUTPUT_TOKENS,
                        // As the routing synthesizer: no reasoning before the object.
                        reasoning: "none",
                        maxRetries: 0,
                        abortSignal: AbortSignal.timeout(SYNTHESIZER_TIMEOUT_MS),
                        output: Output.object({
                            schema: jsonSchema(autoRewriteSynthesizerSchema() as unknown as JSONSchema7),
                            name: "rewrite_test_conversations",
                        }),
                        providerOptions: { openai: { strictJsonSchema: true } },
                    }));
                    const output = outputOf("synthesize", generated);
                    const conversations = (output as { conversations?: unknown } | null)?.conversations;
                    console.info(JSON.stringify({
                        event: "auto_rewrite_optimizer_synthesized",
                        cycleId: input.cycleId,
                        finishReason: generated.finishReason,
                        conversations: Array.isArray(conversations) ? conversations.length : null,
                    }));
                    return {
                        value: output,
                        costMicroUsd: cost(input.optimizerPrices, generated.usage),
                        provider: input.optimizerModel.provider,
                    };
                },
                generate: async (message) => {
                    const generated = await traced("generate", () => generateText({
                        model: getActiveAiModel(input.optimizerModel),
                        system: AUTO_REWRITE_GENERATOR_SYSTEM,
                        prompt: message,
                        maxOutputTokens: GENERATOR_MAX_OUTPUT_TOKENS,
                        maxRetries: 0,
                        abortSignal: AbortSignal.timeout(GENERATOR_TIMEOUT_MS),
                        output: Output.object({
                            schema: jsonSchema(autoRewriteGeneratorSchema() as unknown as JSONSchema7),
                            name: "rewrite_guidance",
                        }),
                        providerOptions: { openai: { strictJsonSchema: true } },
                    }));
                    const guidance = (outputOf("generate", generated) as { guidance?: unknown } | null)?.guidance;
                    const rejection = guidanceRejection(guidance);
                    if (rejection) {
                        console.warn(JSON.stringify({
                            event: "auto_rewrite_optimizer_guidance_rejected",
                            cycleId: input.cycleId,
                            finishReason: generated.finishReason,
                            ...rejection,
                        }));
                    }
                    return {
                        value: typeof guidance === "string" ? guidance : null,
                        costMicroUsd: cost(input.optimizerPrices, generated.usage),
                        provider: input.optimizerModel.provider,
                    };
                },
                // The live request with rewriting on: the same call, so the
                // rewrite passes admitRouterRewrite exactly as a live one does.
                rewrite: async (rewriteGuidance, decision) => {
                    const routed = await callAutoLlmRouter({
                        routerModel: input.routerModel,
                        guidance: input.routingGuidance,
                        prompt: decision.routerInput,
                        previousAnswer: decision.routerContext,
                        candidates: decision.candidates,
                        session: decision.routerSession,
                        rewrite: true,
                        rewriteGuidance,
                        timeoutMs: AUTO_LLM_ROUTER_REPLAY_TIMEOUT_MS,
                    });
                    return {
                        value: routed.pick ? { modelId: routed.pick.modelId, rewrite: routed.pick.rewrite } : null,
                        costMicroUsd: cost(input.routerPrices, routed.usage),
                        provider: input.routerModel.provider,
                    };
                },
                answer: async (modelId, turn) => {
                    const model = answerModels.get(modelId);
                    const prices = model ? pricesOf(model) : null;
                    // No call without a price: its spend could not be recorded.
                    if (!model || !prices) {
                        return { value: null, costMicroUsd: 0, provider: model?.provider ?? "unknown" };
                    }
                    // The routing cycle's answer request: the model's own generation
                    // settings, as a chat turn gets them.
                    const { timeoutMs, ...options } = optimizerAnswerOptions(model, turn);
                    const generated = await traced("answer", () => generateText({
                        model: getActiveAiModel(model),
                        abortSignal: AbortSignal.timeout(timeoutMs),
                        ...options,
                    }));
                    return {
                        value: generated.text,
                        costMicroUsd: cost(prices, generated.usage),
                        provider: model.provider,
                    };
                },
                judge: async (message) => {
                    // The routing optimizer's judge call: one place for its limits.
                    const generated = await traced("judge", () => optimizerJudgeCall({
                        model: input.optimizerModel,
                        system: AUTO_REWRITE_JUDGE_SYSTEM,
                        prompt: message,
                        name: "rewrite_judgement",
                    }));
                    return {
                        value: parseJudgeWinner(outputOf("judge", generated)),
                        costMicroUsd: cost(input.optimizerPrices, generated.usage),
                        provider: input.optimizerModel.provider,
                    };
                },
            }
        );
        known = { spentMicroUsd: result.spentMicroUsd, spentByProvider: result.spentByProvider };
        const recorded = await finishOptimizerCycle({
            cycleId: input.cycleId,
            data: {
                status: result.status,
                failure: result.failure,
                candidateGuidance: result.candidateGuidance,
                cases: result.cases,
                summary: { ...result.summary, failedCalls: result.failedCalls, judgeFailed: result.judgeFailed },
                spentMicroUsd: result.spentMicroUsd,
                finishedAt: new Date(),
            },
            spentByProvider: result.spentByProvider,
        });
        let promotion:
            | Awaited<ReturnType<typeof promoteAutoRewriteOptimizerCycle>>
            | { refused: "promotion_error" }
            | null = null;
        if (recorded && result.status === "passed" && (await readRewriteOptimizerAutomation()).autoPromote) {
            promotion = await promoteAutoRewriteOptimizerCycle(input.cycleId, "system").catch(
                () => ({ refused: "promotion_error" as const })
            );
        }
        console.info(JSON.stringify({
            event: "auto_rewrite_optimizer_cycle",
            cycleId: input.cycleId,
            recorded,
            autoPromoted: promotion ? ("ok" in promotion ? true : promotion.refused) : false,
            status: result.status,
            failure: result.failure,
            spentMicroUsd: result.spentMicroUsd,
            spentByKind: result.spentByKind,
            spentByProvider: Object.fromEntries(result.spentByProvider),
            failedCalls: result.failedCalls,
            judgeFailed: result.judgeFailed,
            syntheticCases: result.cases.filter((item) => item.source === "synthetic").length,
            decided: result.summary.decided,
            undecided: result.summary.undecided,
        }));
        return { recorded, status: result.status, failure: result.failure };
    } catch (error) {
        // As in the routing cycle: the spend known by then is booked through
        // the same compare-and-set as a normal finish, at most once.
        console.error(JSON.stringify({
            event: "auto_rewrite_optimizer_cycle_failed",
            cycleId: input.cycleId,
            error: error instanceof Error ? error.name : "unknown",
            knownSpentMicroUsd: known.spentMicroUsd,
            knownSpentByProvider: Object.fromEntries(known.spentByProvider),
        }));
        await finishOptimizerCycle({
            cycleId: input.cycleId,
            data: { status: "error", failure: "run_error", spentMicroUsd: known.spentMicroUsd, finishedAt: new Date() },
            spentByProvider: known.spentByProvider,
        }).catch(() => undefined);
        return { recorded: false, status: "error", failure: "run_error" };
    }
}

type AdminActor = { session: Session; request: Request };

/**
 * Makes a passed rewrite cycle's guidance the one the live router reads when
 * rewriting is on. The same compare-and-set as a routing promotion, on the
 * rewrite guidance: refused unless the guidance in force is the one the cycle
 * measured against.
 */
export async function promoteAutoRewriteOptimizerCycle(
    cycleId: string,
    actor: OptimizerActor
): Promise<{ ok: true } | { refused: "not_found" | "not_passed" | "already_promoted" | "stale" }> {
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OPTIMIZER_LOCK}))`;
        const cycle = await tx.autoRouterOptimizerCycle.findUnique({
            where: { id: cycleId },
            select: { status: true, candidateGuidance: true, incumbentGuidance: true, promotedAt: true, target: true },
        });
        if (!cycle || cycle.target !== "rewrite") return { refused: "not_found" as const };
        if (cycle.promotedAt) return { refused: "already_promoted" as const };
        if (cycle.status !== "passed" || !cycle.candidateGuidance) return { refused: "not_passed" as const };
        const active = await readActiveRouterGuidance(tx, "rewrite");
        if (active.guidance !== cycle.incumbentGuidance) return { refused: "stale" as const };
        await writeActiveRouterGuidance(
            tx,
            promotedRouterGuidance(active, { guidance: cycle.candidateGuidance, cycleId }),
            "rewrite"
        );
        await tx.autoRouterOptimizerCycle.update({ where: { id: cycleId }, data: { promotedAt: new Date() } });
        const entry = {
            action: "auto.llm_router_rewrite_guidance.promoted" as const,
            targetId: cycleId,
            summary: actor === "system"
                ? "Promoted Auto router rewrite guidance automatically from a passed cycle."
                : "Promoted Auto router rewrite guidance from an optimizer cycle.",
            metadata: { previousCycleId: active.cycleId },
        };
        if (actor === "system") await writeAutoRouterOptimizerSystemAudit(tx, entry);
        else await writeAdminAuditLog({ ...actor, tx, targetType: "AutoRouterOptimizerCycle", ...entry });
        return { ok: true as const };
    });
}

/** Returns the rewrite guidance to the one before it (or the default). */
export async function rollBackAutoRewriteGuidance(
    actor: AdminActor
): Promise<{ ok: true } | { refused: "nothing_to_roll_back" }> {
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OPTIMIZER_LOCK}))`;
        const active = await readActiveRouterGuidance(tx, "rewrite");
        const restored = rolledBackRouterGuidance(active, DEFAULT_ROUTER_REWRITE_GUIDANCE.guidance);
        if (!restored) return { refused: "nothing_to_roll_back" as const };
        await writeActiveRouterGuidance(tx, restored, "rewrite");
        await writeAdminAuditLog({
            ...actor,
            tx,
            action: "auto.llm_router_rewrite_guidance.rolled_back",
            targetType: "AutoRouterOptimizerCycle",
            targetId: active.cycleId,
            summary: "Rolled Auto router rewrite guidance back one step.",
            metadata: { restoredCycleId: restored.cycleId },
        });
        return { ok: true as const };
    });
}

/** Sets the rewrite automation switches in one transaction with their audit entry. */
export async function updateRewriteOptimizerAutomation(actor: AdminActor, after: RewriteOptimizerAutomation) {
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        const before = await readRewriteOptimizerAutomation(tx);
        await writeRewriteOptimizerAutomation(tx, after);
        await writeAdminAuditLog({
            ...actor,
            tx,
            action: "auto.llm_router_rewrite_optimizer_automation.updated",
            targetType: "AppSettings",
            targetId: AUTO_REWRITE_OPTIMIZER_AUTOMATION_SETTING_KEY,
            summary: `Set the Auto router rewrite optimizer automation: daily ${after.daily ? "on" : "off"}, auto-promote ${after.autoPromote ? "on" : "off"}.`,
            metadata: { before, after },
        });
    });
}

/** How many recent rewrite cycles Admin lists; the panel says so. */
export const AUTO_REWRITE_OPTIMIZER_LISTED_CYCLES = 10;

export type RewriteOptimizerCycleView = {
    id: string;
    createdAt: string;
    status: string;
    failure: string | null;
    optimizerModelId: string;
    candidateGuidance: string | null;
    summary: unknown;
    spentMicroUsd: number;
    promotedAt: string | null;
    syntheticCases: RewriteSyntheticCaseView[];
};

/**
 * Everything the rewrite section of Admin shows. No real turn's content: its
 * message and rewrites are a user's, so a real case is a count. Synthetic
 * conversations, which no user wrote, are shown with both rewrites.
 */
export async function readAutoRewriteOptimizerState() {
    const now = new Date();
    const [optimizerModelId, automation, active, liveRewrite, cycles] = await Promise.all([
        readOptimizerModelId(),
        readRewriteOptimizerAutomation(),
        readActiveRouterGuidance(prisma, "rewrite"),
        readAutoLlmRouterRewrite(),
        prisma.autoRouterOptimizerCycle.findMany({
            where: { target: "rewrite" },
            orderBy: { createdAt: "desc" },
            take: AUTO_REWRITE_OPTIMIZER_LISTED_CYCLES,
            select: {
                id: true, createdAt: true, status: true, failure: true, optimizerModelId: true,
                candidateGuidance: true, summary: true, spentMicroUsd: true, promotedAt: true, cases: true,
            },
        }),
    ]);
    return {
        optimizerModelId,
        automation,
        liveRewrite,
        listedCycles: AUTO_REWRITE_OPTIMIZER_LISTED_CYCLES,
        active: { cycleId: active.cycleId, guidance: active.guidance, canRollBack: active.cycleId !== null },
        cycles: cycles.map(({ cases, ...cycle }): RewriteOptimizerCycleView => ({
            ...cycle,
            ...optimizerCycleView(cycle, now),
            syntheticCases: rewriteSyntheticCaseViews(cases),
            createdAt: cycle.createdAt.toISOString(),
            promotedAt: cycle.promotedAt?.toISOString() ?? null,
        })),
    };
}

/**
 * The daily maintenance run's optimizer step, for both targets: at most one
 * cycle a day (the system's daily count is shared), routing as before when
 * only its switch is on, rewrite when only the rewrite switch is on, and the
 * two in turn when both are. Off, or any refusal, starts nothing and costs
 * nothing. `waitForCompletion` runs the cycle to its end before returning.
 */
export async function runScheduledOptimizerCycle(options: { waitForCompletion?: boolean } = {}): Promise<
    | { started: false; reason: "daily_off" | OptimizerStartRefusal; target?: "routing" | "rewrite" }
    | { started: true; cycleId: string; target: "routing" | "rewrite"; outcome?: OptimizerRunOutcome }
> {
    const [routing, rewrite] = await Promise.all([readOptimizerAutomation(), readRewriteOptimizerAutomation()]);
    const last =
        routing.daily && rewrite.daily
            ? await prisma.autoRouterOptimizerCycle.findFirst({
                  where: { startedBy: "system" },
                  orderBy: { createdAt: "desc" },
                  select: { target: true },
              })
            : null;
    const target = scheduledOptimizerTarget({
        routingDaily: routing.daily,
        rewriteDaily: rewrite.daily,
        lastSystemTarget: last?.target === "rewrite" ? "rewrite" : last?.target === "routing" ? "routing" : null,
    });
    if (!target) return { started: false, reason: "daily_off" };
    if (target === "routing") return { ...(await runScheduledAutoRouterOptimizerCycle(options)), target };
    const result = await startAutoRewriteOptimizerCycle("system", options);
    return "refused" in result
        ? { started: false, reason: result.refused, target }
        : { started: true, cycleId: result.cycleId, target, ...(result.outcome ? { outcome: result.outcome } : {}) };
}

/**
 * The own-process optimizer service's run (scripts/run-auto-router-optimizer.mjs):
 * the same daily rule and the same reserve, run and finish as the maintenance
 * route's step, but waited for, so a web redeploy cannot cut the cycle off and
 * leave its spend unrecorded.
 */
export const runAutoRouterOptimizerCycleToCompletion = () =>
    runScheduledOptimizerCycle({ waitForCompletion: true });
