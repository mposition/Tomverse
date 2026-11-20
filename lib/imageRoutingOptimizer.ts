import "server-only";

import { generateText, jsonSchema, Output } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { getActiveAiModel } from "@/lib/activeAiModel";
import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { autoLlmRouterWorstCaseMicroUsd, resolveAutoLlmRouterModel } from "@/lib/autoLlmRouterCore";
import { DEFAULT_ROUTER_IMAGE_GUIDANCE, readActiveRouterGuidance, writeActiveRouterGuidance } from "@/lib/autoLlmRouterGuidance";
import {
    OPTIMIZER_LOCK,
    finishOptimizerCycle,
    pricesOf,
    readOptimizerModelId,
    reserveOptimizerCycle,
    type OptimizerActor,
    type OptimizerStartRefusal,
    type Prices,
} from "@/lib/autoRouterOptimizer";
import { optimizerCycleView, promotedRouterGuidance, rolledBackRouterGuidance, type OptimizerRunOutcome } from "@/lib/autoRouterOptimizerCore";
import { writeAutoRouterOptimizerSystemAudit } from "@/lib/autoRouterOptimizerSystemAudit";
import { chatImageRoutingCandidates, chatImageTriageModelId, probeChatImageRouting } from "@/lib/chatImageIntent";
import { CHAT_IMAGE_INTENT_MAX_OUTPUT_TOKENS, buildChatImageIntentSystem, chatImageIntentUserMessage } from "@/lib/chatImageIntentCore";
import { holdChatUsageBucket, usagePeriodStart } from "@/lib/chatSecurity";
import { refundProviderBudget } from "@/lib/imageGenerationService";
import { imageProviderBudgetBucketKey, resolveImageProviderBudget } from "@/lib/imageProviderBudget";
import { listEnabledImageModels, type ImageModelProvider } from "@/lib/imageModelRegistry";
import { readImageRoutingReport } from "@/lib/imageRoutingReport";
import { runImageModelEval } from "@/lib/imageRoutingModelEval";
import { IMAGE_ROUTING_JUDGE_MAX_OUTPUT_TOKENS } from "@/lib/imageRoutingModelEvalCore";
import {
    IMAGE_ROUTING_SYNTHESIZER_SYSTEM,
    admitSyntheticImageRequests,
    imageRoutingSynthesizerOutputSchema,
    imageRoutingSynthesizerUserMessage,
    summarizeImageModelEval,
    type ImageEvalCase,
    type SyntheticImageRequest,
} from "@/lib/imageRoutingModelEvalCore";
import {
    IMAGE_CRITERIA_GENERATOR_SYSTEM,
    IMAGE_INTENT_SYNTHESIZER_SYSTEM,
    admitImageCriteria,
    admitImageCriteriaReport,
    admitImageIntentCases,
    imageCriteriaGeneratorMessage,
    imageCriteriaGeneratorSchema,
    imageCyclePromotable,
    imageCycleGate,
    imageIntentSynthesizerSchema,
    modelChoiceAgreement,
    scoreImageIntent,
    splitImageIntentCases,
    type ImageIntentCase,
} from "@/lib/imageRoutingOptimizerCore";
import { getRuntimeModels } from "@/lib/modelRegistry";
import type { AiModel } from "@/lib/models";
import { prisma } from "@/lib/prisma";

/**
 * The image routing optimizer (lib/imageRoutingOptimizerCore.ts): one cycle
 * improves Chat's image routing criteria, on the shared optimizer table, lock,
 * day and month caps (reserveOptimizerCycle, target "image"), recording and
 * audit. The routing calls use the live image routing model (the Auto router
 * model with image triage on) exactly as live; the optimizer model writes the
 * cases and the proposal and, in the model evaluation, judges the images.
 *
 * Paid. The daily cycle is on by default (owner decision 2026-11-20); it makes
 * text calls only. The model evaluation makes real images (image providers,
 * booked to their own budget buckets) and is off until the owner turns it on.
 * Promotion is a person's click unless auto-promote is on (default off).
 */

export const AUTO_IMAGE_OPTIMIZER_AUTOMATION_SETTING_KEY = "auto.llmRouterImageOptimizerAutomation";

export type ImageOptimizerAutomation = { daily: boolean; autoPromote: boolean; modelEval: boolean };

/**
 * No row: everything off. The daily cycle is a new paid run (text calls under
 * the shared optimizer caps), so the owner turns it on in Admin › Routing.
 */
export const IMAGE_OPTIMIZER_AUTOMATION_DEFAULT: ImageOptimizerAutomation = { daily: false, autoPromote: false, modelEval: false };

const ALL_OFF: ImageOptimizerAutomation = { daily: false, autoPromote: false, modelEval: false };

export async function readImageOptimizerAutomation(
    db: Pick<Prisma.TransactionClient, "appSetting"> = prisma
): Promise<ImageOptimizerAutomation> {
    try {
        const row = await db.appSetting.findUnique({ where: { key: AUTO_IMAGE_OPTIMIZER_AUTOMATION_SETTING_KEY }, select: { value: true } });
        if (!row) return { ...IMAGE_OPTIMIZER_AUTOMATION_DEFAULT };
        const value: unknown = JSON.parse(row.value);
        // Only a whole, well-formed setting counts; anything else spends nothing.
        if (!value || typeof value !== "object" || Array.isArray(value)) return { ...ALL_OFF };
        const { daily, autoPromote, modelEval } = value as Record<string, unknown>;
        if (typeof daily !== "boolean" || typeof autoPromote !== "boolean" || typeof modelEval !== "boolean") return { ...ALL_OFF };
        return { daily, autoPromote, modelEval };
    } catch {
        return { ...ALL_OFF };
    }
}

async function writeImageOptimizerAutomation(tx: Prisma.TransactionClient, value: ImageOptimizerAutomation) {
    const isDefault = (Object.keys(IMAGE_OPTIMIZER_AUTOMATION_DEFAULT) as (keyof ImageOptimizerAutomation)[]).every(
        (key) => value[key] === IMAGE_OPTIMIZER_AUTOMATION_DEFAULT[key]
    );
    if (isDefault) {
        await tx.appSetting.deleteMany({ where: { key: AUTO_IMAGE_OPTIMIZER_AUTOMATION_SETTING_KEY } });
        return;
    }
    const stored = JSON.stringify({ daily: value.daily, autoPromote: value.autoPromote, modelEval: value.modelEval });
    await tx.appSetting.upsert({
        where: { key: AUTO_IMAGE_OPTIMIZER_AUTOMATION_SETTING_KEY },
        create: { key: AUTO_IMAGE_OPTIMIZER_AUTOMATION_SETTING_KEY, value: stored },
        update: { value: stored },
    });
}

const INTENT_CASES = 32;
const MODEL_EVAL_REQUESTS = 12;
/** Share of the cycle's budget the image-making evaluation may spend. */
const MODEL_EVAL_BUDGET_SHARE = 0.5;
/** The image adapter retries a failed request up to twice: an image of unknown cost is charged three worst cases. */
const IMAGE_ATTEMPTS_BOUND = 3;

type ImageEvalProviderHold = { provider: string; microUsd: number; at: Date };

/**
 * Holds an evaluation image's worst case in its provider's day and month
 * buckets, refused at the same floor-clamped limits a person's image is
 * (lib/imageGenerationService.ts), in one transaction: both windows or none.
 * Null when the provider has no usable budget or either window is full.
 */
async function holdImageEvalProviderBudget(provider: string, microUsd: number): Promise<ImageEvalProviderHold | null> {
    const limits = resolveImageProviderBudget(process.env, { provider: provider as ImageModelProvider }).limits;
    if (!limits || microUsd <= 0) return null;
    const at = new Date();
    try {
        return await prisma.$transaction(async (tx) => {
            for (const window of [
                { period: "provider-cost-day", start: usagePeriodStart("day", at), limit: limits.day },
                { period: "provider-cost-month", start: usagePeriodStart("month", at), limit: limits.month },
            ]) {
                const held = await holdChatUsageBucket(tx, imageProviderBudgetBucketKey(provider), window.period, window.start, window.limit, microUsd);
                if (!held) throw new ImageEvalBudgetRefused();
            }
            return { provider, microUsd, at };
        });
    } catch (error) {
        if (error instanceof ImageEvalBudgetRefused) return null;
        throw error;
    }
}

class ImageEvalBudgetRefused extends Error {}

/** Gives back the part of a hold the image did not cost. */
async function releaseImageEvalProviderBudget(hold: ImageEvalProviderHold, paidMicroUsd: number) {
    const unused = hold.microUsd - Math.max(0, paidMicroUsd);
    if (unused <= 0) return;
    await prisma.$transaction((tx) => refundProviderBudget(tx, hold.provider, unused, hold.at));
}
const GENERATOR_MAX_OUTPUT_TOKENS = 8_000;
/**
 * One vision judge call: two 1024x1024 images (no provider bills one above
 * about 1,600 tokens; 8,000 each leaves room) and the request with
 * instructions, against an output limit of 64 tokens (raised for safety).
 */
const JUDGE_CALL_INPUT_TOKENS_BOUND = 2 * 8_000 + 8_000;
const JUDGE_CALL_OUTPUT_TOKENS = IMAGE_ROUTING_JUDGE_MAX_OUTPUT_TOKENS;
const SYNTHESIZER_MAX_OUTPUT_TOKENS = 12_000;
const CALL_TIMEOUT_MS = 150_000;

export type ImageOptimizerStartRefusal = OptimizerStartRefusal | "image_triage_off";

const tokens = (value: number | undefined) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const costOf = (prices: Prices, usage: { inputTokens?: number; outputTokens?: number } | undefined) => {
    const input = tokens(usage?.inputTokens);
    const output = tokens(usage?.outputTokens);
    return input === null || output === null
        ? null
        : Math.ceil(input * prices.inputUsdPerMillionTokens + output * prices.outputUsdPerMillionTokens);
};

export async function startImageRoutingOptimizerCycle(
    actor: OptimizerActor,
    options: { waitForCompletion?: boolean } = {}
): Promise<{ cycleId: string; outcome?: OptimizerRunOutcome } | { refused: ImageOptimizerStartRefusal }> {
    const models = await getRuntimeModels();
    const optimizerModel = resolveAutoLlmRouterModel(models, (await readOptimizerModelId()) ?? undefined);
    if (!optimizerModel) return { refused: "optimizer_off" };
    const routerModel = resolveAutoLlmRouterModel(models, (await chatImageTriageModelId()) ?? undefined);
    if (!routerModel) return { refused: "image_triage_off" };
    const optimizerPrices = pricesOf(optimizerModel);
    const routerPrices = pricesOf(routerModel);
    if (!optimizerPrices || !routerPrices) return { refused: "pricing_unavailable" };

    const active = await readActiveRouterGuidance(prisma, "image");
    const started = await reserveOptimizerCycle({
        actor,
        optimizerModelId: optimizerModel.id,
        routerModelId: routerModel.id,
        incumbentGuidance: active.guidance,
        target: "image",
    });
    if ("refused" in started) return started;
    const run = runImageCycle({
        cycleId: started.cycle.id,
        budgetMicroUsd: started.cycle.budgetMicroUsd,
        incumbent: active.guidance,
        optimizerModel,
        routerModel,
        optimizerPrices,
        routerPrices,
        modelEval: (await readImageOptimizerAutomation()).modelEval,
    });
    if (!options.waitForCompletion) {
        void run;
        return { cycleId: started.cycle.id };
    }
    return { cycleId: started.cycle.id, outcome: await run };
}

/** What a cycle has spent, by bucket and provider, and whether every cost is known. */
const spendTracker = (budgetMicroUsd: number) => {
    const model = new Map<string, number>();
    const image = new Map<string, number>();
    let total = 0;
    let unknown = 0;
    let exhausted = false;
    return {
        /** Whether a call of this worst case still fits; a no marks the budget exhausted. */
        fits(worst: number) {
            const fits = Number.isFinite(worst) && total + worst <= budgetMicroUsd;
            if (!fits) exhausted = true;
            return fits;
        },
        add(bucket: "model" | "image", provider: string, microUsd: number, known: boolean) {
            const map = bucket === "model" ? model : image;
            map.set(provider, (map.get(provider) ?? 0) + microUsd);
            total += microUsd;
            if (!known) unknown += 1;
        },
        get total() {
            return total;
        },
        get unknown() {
            return unknown;
        },
        get exhausted() {
            return exhausted;
        },
        model,
        image,
    };
};

async function runImageCycle(input: {
    cycleId: string;
    budgetMicroUsd: number;
    incumbent: string;
    optimizerModel: AiModel;
    routerModel: AiModel;
    optimizerPrices: Prices;
    routerPrices: Prices;
    modelEval: boolean;
}): Promise<OptimizerRunOutcome> {
    const spend = spendTracker(input.budgetMicroUsd);
    let stop: "budget" | "cost_unknown" | null = null;

    /** One structured call to the optimizer model, its worst case checked first. */
    const optimizerCall = async (system: string, prompt: string, schema: object, name: string, maxOutputTokens: number) => {
        const worst = autoLlmRouterWorstCaseMicroUsd({ system, prompt, maxOutputTokens, ...input.optimizerPrices });
        if (worst === null || !spend.fits(worst)) {
            stop ??= "budget";
            return null;
        }
        try {
            const generated = await generateText({
                model: getActiveAiModel(input.optimizerModel),
                system,
                prompt,
                maxOutputTokens,
                maxRetries: 0,
                abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
                output: Output.object({ schema: jsonSchema(schema as JSONSchema7), name }),
                providerOptions: { openai: { strictJsonSchema: true } },
            });
            const cost = costOf(input.optimizerPrices, generated.usage);
            spend.add("model", input.optimizerModel.provider, cost ?? worst, cost !== null);
            if (cost === null) stop = "cost_unknown";
            try {
                return generated.output as unknown;
            } catch {
                return null;
            }
        } catch {
            // A failed call may still have been billed: its worst case is spend.
            spend.add("model", input.optimizerModel.provider, worst, false);
            stop = "cost_unknown";
            return null;
        }
    };

    try {
        const [candidates, liveReport] = await Promise.all([
            chatImageRoutingCandidates(),
            readImageRoutingReport(7).catch(() => null),
        ]);
        /** One routing call with these criteria, its worst case checked first; null when not made or failed. */
        const route = async (criteria: string, text: string) => {
            if (stop) return null;
            const worst = autoLlmRouterWorstCaseMicroUsd({
                system: buildChatImageIntentSystem({ criteria }),
                prompt: chatImageIntentUserMessage(text, candidates, null, false),
                maxOutputTokens: CHAT_IMAGE_INTENT_MAX_OUTPUT_TOKENS,
                ...input.routerPrices,
            });
            if (worst === null || !spend.fits(worst)) {
                stop ??= "budget";
                return null;
            }
            const probe = await probeChatImageRouting({ model: input.routerModel, criteria, text, candidates });
            const cost = probe.failed ? null : costOf(input.routerPrices, probe.usage);
            spend.add("model", input.routerModel.provider, cost ?? worst, cost !== null);
            if (cost === null) {
                stop = "cost_unknown";
                return null;
            }
            return probe.decision;
        };

        // Stage 3: labelled messages, split into training and the withheld half.
        const intentCases = admitImageIntentCases(
            await optimizerCall(IMAGE_INTENT_SYNTHESIZER_SYSTEM, `Write ${INTENT_CASES} different messages.`, imageIntentSynthesizerSchema(), "image_intent_cases", SYNTHESIZER_MAX_OUTPUT_TOKENS),
            INTENT_CASES
        );
        const { train, evaluate } = splitImageIntentCases(intentCases);

        // Stage 4 (its own switch): real images from the current pick and a challenger.
        let modelCases: ImageEvalCase[] = [];
        let modelRequests: SyntheticImageRequest[] = [];
        if (input.modelEval && !stop) {
            modelRequests = admitSyntheticImageRequests(
                await optimizerCall(
                    IMAGE_ROUTING_SYNTHESIZER_SYSTEM,
                    imageRoutingSynthesizerUserMessage(MODEL_EVAL_REQUESTS),
                    imageRoutingSynthesizerOutputSchema(MODEL_EVAL_REQUESTS),
                    "image_routing_requests",
                    SYNTHESIZER_MAX_OUTPUT_TOKENS
                ),
                MODEL_EVAL_REQUESTS
            );
            const evalBudget = spend.total + Math.floor((input.budgetMicroUsd - spend.total) * MODEL_EVAL_BUDGET_SHARE);
            const enabled = listEnabledImageModels().filter((model) => candidates.some((candidate) => candidate.id === model.id));
            // A judged pair is two vision calls, each two images and a short text:
            // JUDGE_CALL_INPUT_TOKENS_BOUND input and JUDGE_CALL_OUTPUT_TOKENS output at most.
            const judgeWorst =
                2 *
                Math.ceil(
                    JUDGE_CALL_INPUT_TOKENS_BOUND * input.optimizerPrices.inputUsdPerMillionTokens +
                        JUDGE_CALL_OUTPUT_TOKENS * input.optimizerPrices.outputUsdPerMillionTokens
                );
            // The image hold not yet settled (one image at a time).
            let pendingImageHold: ImageEvalProviderHold | null = null;
            const result = await runImageModelEval({
                requests: modelRequests,
                pickFor: async (request) => {
                    const decision = await route(input.incumbent, request.text);
                    return decision?.image && decision.modelId ? { modelId: decision.modelId, preset: decision.preset ?? "standard" } : null;
                },
                candidates: enabled.map((model) => ({ model })),
                judgeModel: input.optimizerModel,
                judgeWorstCaseMicroUsd: judgeWorst,
                judgeUsdPerMillionTokens: { input: input.optimizerPrices.inputUsdPerMillionTokens, output: input.optimizerPrices.outputUsdPerMillionTokens },
                // An image's worst case covers the adapter's retries; a judged
                // pair's is already both calls. An image also holds its worst
                // case in the image provider's day and month buckets, under the
                // same operational limits as a person's image, before the call.
                shouldContinue: async (worst, call) => {
                    const need = call.kind === "image" ? worst * IMAGE_ATTEMPTS_BOUND : worst;
                    if (stop || spend.total + need > evalBudget || !spend.fits(need)) return false;
                    if (call.kind !== "image") return true;
                    const held = await holdImageEvalProviderBudget(call.provider, Math.ceil(need));
                    if (!held) return false;
                    pendingImageHold = held;
                    return true;
                },
                onCost: async (cost) => {
                    const amount = cost.known ? cost.microUsd : cost.kind === "image" ? cost.microUsd * IMAGE_ATTEMPTS_BOUND : cost.microUsd;
                    spend.add(cost.kind === "image" ? "image" : "model", cost.provider, amount, cost.known);
                    if (!cost.known) stop = "cost_unknown";
                    // The hold becomes what was paid: the rest goes back.
                    if (cost.kind === "image" && pendingImageHold?.provider === cost.provider) {
                        await releaseImageEvalProviderBudget(pendingImageHold, Math.ceil(amount));
                        pendingImageHold = null;
                    }
                },
            });
            modelCases = result.cases;
        }
        const winners = modelCases.map((item) =>
            item.outcome === "pick_win" ? item.pick.modelId : item.outcome === "challenger_win" ? item.challenger?.modelId ?? null : null
        );
        const modelEvaluation = modelCases.length ? summarizeImageModelEval(modelCases) : null;

        // The current criteria on the training half, for the generator's errors.
        const trainAnswers: (boolean | null)[] = [];
        for (const item of train) trainAnswers.push((await route(input.incumbent, item.text))?.image ?? null);
        const errors = train.flatMap((item, index) =>
            trainAnswers[index] === item.expectImage ? [] : [{ text: item.text, expectImage: item.expectImage, answeredImage: trainAnswers[index], kind: item.kind }]
        );
        const generated = stop
            ? null
            : await optimizerCall(
                  IMAGE_CRITERIA_GENERATOR_SYSTEM,
                  imageCriteriaGeneratorMessage({ criteria: input.incumbent, errors, modelEvaluation, liveReport }),
                  imageCriteriaGeneratorSchema(),
                  "image_routing_criteria",
                  GENERATOR_MAX_OUTPUT_TOKENS
              );
        const candidate = admitImageCriteria((generated as { criteria?: unknown } | null)?.criteria, input.incumbent);
        const report = admitImageCriteriaReport(generated);

        // The withheld half, with both criteria; then the proposal's picks on the judged requests.
        const answer = async (criteria: string, items: readonly ImageIntentCase[]) => {
            const answers: ({ image: boolean } | null)[] = [];
            for (const item of items) {
                const decision = await route(criteria, item.text);
                answers.push(decision ? { image: decision.image } : null);
            }
            return answers;
        };
        const incumbentScore = scoreImageIntent(evaluate, await answer(input.incumbent, evaluate));
        const candidateScore = candidate ? scoreImageIntent(evaluate, await answer(candidate, evaluate)) : null;
        const incumbentPicks = modelCases.map((item) => item.pick.modelId);
        const candidatePicks: (string | null)[] = [];
        if (candidate) {
            // The evaluation records one case per request, in order, until it stops.
            for (const [index, item] of modelCases.entries()) {
                const request = modelRequests[index];
                if (!winners[index] || !request || request.category !== item.category) {
                    candidatePicks.push(null);
                    continue;
                }
                const decision = await route(candidate, request.text);
                candidatePicks.push(decision?.image ? decision.modelId : null);
            }
        }
        const incumbentAgreement = modelChoiceAgreement(winners, incumbentPicks);
        const candidateAgreement = modelChoiceAgreement(winners, candidatePicks);
        const costComplete = spend.unknown === 0;
        const failure = imageCycleGate({
            costComplete,
            budgetExhausted: stop === "budget" || (spend.exhausted && !candidateScore),
            candidate,
            incumbentScore,
            candidateScore,
            incumbentAgreement,
            candidateAgreement,
        });
        const status = failure ? "failed" : "passed";
        const recorded = await finishOptimizerCycle({
            cycleId: input.cycleId,
            data: {
                status,
                failure,
                candidateGuidance: candidate,
                cases: intentCases.map((item) => ({ source: "synthetic", message: item.text, kind: item.kind, expectImage: item.expectImage })),
                summary: {
                    mode: input.modelEval ? "intent_and_models" : "intent",
                    costComplete,
                    unknownCostCalls: spend.unknown,
                    intent: { incumbent: incumbentScore, candidate: candidateScore, trainErrors: errors.length },
                    modelEvaluation,
                    agreement: { incumbent: incumbentAgreement, candidate: candidateAgreement },
                    report,
                    liveReport,
                    stop,
                },
                spentMicroUsd: spend.total,
                finishedAt: new Date(),
            },
            spentByProvider: spend.model,
            // Image spend is already in the image provider buckets (held, then settled).
        });
        let autoPromoted: boolean | string = false;
        if (recorded && status === "passed" && (await readImageOptimizerAutomation()).autoPromote) {
            const promotion = await promoteImageRoutingOptimizerCycle(input.cycleId, "system").catch(() => ({ refused: "promotion_error" as const }));
            autoPromoted = "ok" in promotion ? true : promotion.refused;
        }
        console.info(JSON.stringify({
            event: "image_routing_optimizer_cycle",
            cycleId: input.cycleId,
            recorded,
            autoPromoted,
            status,
            failure,
            spentMicroUsd: spend.total,
            intentCases: intentCases.length,
            modelCases: modelCases.length,
            stop,
        }));
        return { recorded, status, failure };
    } catch (error) {
        console.error(JSON.stringify({ event: "image_routing_optimizer_cycle_failed", cycleId: input.cycleId, error: error instanceof Error ? error.name : "unknown", knownSpentMicroUsd: spend.total }));
        await finishOptimizerCycle({
            cycleId: input.cycleId,
            data: { status: "error", failure: "run_error", spentMicroUsd: spend.total, finishedAt: new Date() },
            spentByProvider: spend.model,
            // Image spend is already in the image provider buckets (held, then settled).
        }).catch(() => undefined);
        return { recorded: false, status: "error", failure: "run_error" };
    }
}

type AdminActor = { session: Session; request: Request };

/** Makes a passed image cycle's criteria the ones Chat's image routing follows. */
export async function promoteImageRoutingOptimizerCycle(
    cycleId: string,
    actor: OptimizerActor
): Promise<{ ok: true } | { refused: "not_found" | "not_passed" | "already_promoted" | "stale" }> {
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OPTIMIZER_LOCK}))`;
        const cycle = await tx.autoRouterOptimizerCycle.findUnique({
            where: { id: cycleId },
            select: { status: true, candidateGuidance: true, incumbentGuidance: true, promotedAt: true, target: true, summary: true },
        });
        if (!cycle || cycle.target !== "image") return { refused: "not_found" as const };
        if (cycle.promotedAt) return { refused: "already_promoted" as const };
        if (!imageCyclePromotable(cycle)) return { refused: "not_passed" as const };
        const active = await readActiveRouterGuidance(tx, "image");
        if (active.guidance !== cycle.incumbentGuidance) return { refused: "stale" as const };
        await writeActiveRouterGuidance(tx, promotedRouterGuidance(active, { guidance: cycle.candidateGuidance!, cycleId }), "image");
        await tx.autoRouterOptimizerCycle.update({ where: { id: cycleId }, data: { promotedAt: new Date() } });
        const entry = {
            action: "auto.llm_router_image_guidance.promoted" as const,
            targetId: cycleId,
            summary: actor === "system"
                ? "Promoted the image routing criteria automatically from a passed cycle."
                : "Promoted the image routing criteria from an optimizer cycle.",
            metadata: { previousCycleId: active.cycleId },
        };
        if (actor === "system") await writeAutoRouterOptimizerSystemAudit(tx, entry);
        else await writeAdminAuditLog({ ...actor, tx, targetType: "AutoRouterOptimizerCycle", ...entry });
        return { ok: true as const };
    });
}

/** Returns the image routing criteria to the ones before (or the code default). */
export async function rollBackImageRoutingGuidance(actor: AdminActor): Promise<{ ok: true } | { refused: "nothing_to_roll_back" }> {
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OPTIMIZER_LOCK}))`;
        const active = await readActiveRouterGuidance(tx, "image");
        const restored = rolledBackRouterGuidance(active, DEFAULT_ROUTER_IMAGE_GUIDANCE.guidance);
        if (!restored) return { refused: "nothing_to_roll_back" as const };
        await writeActiveRouterGuidance(tx, restored, "image");
        await writeAdminAuditLog({
            ...actor,
            tx,
            action: "auto.llm_router_image_guidance.rolled_back",
            targetType: "AutoRouterOptimizerCycle",
            targetId: active.cycleId,
            summary: "Rolled the image routing criteria back one step.",
            metadata: { restoredCycleId: restored.cycleId },
        });
        return { ok: true as const };
    });
}

export async function updateImageOptimizerAutomation(actor: AdminActor, after: ImageOptimizerAutomation) {
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        const before = await readImageOptimizerAutomation(tx);
        await writeImageOptimizerAutomation(tx, after);
        await writeAdminAuditLog({
            ...actor,
            tx,
            action: "auto.llm_router_image_optimizer_automation.updated",
            targetType: "AppSettings",
            targetId: AUTO_IMAGE_OPTIMIZER_AUTOMATION_SETTING_KEY,
            summary: `Set the image routing optimizer automation: daily ${after.daily ? "on" : "off"}, auto-promote ${after.autoPromote ? "on" : "off"}, image evaluation ${after.modelEval ? "on" : "off"}.`,
            metadata: { before, after },
        });
    });
}

export const AUTO_IMAGE_OPTIMIZER_LISTED_CYCLES = 10;

/** Everything the image section of Admin shows; synthetic cases only, no user's text. */
export async function readImageRoutingOptimizerState() {
    const now = new Date();
    const [optimizerModelId, triageModelId, automation, active, cycles, day, week] = await Promise.all([
        readOptimizerModelId(),
        chatImageTriageModelId(),
        readImageOptimizerAutomation(),
        readActiveRouterGuidance(prisma, "image"),
        prisma.autoRouterOptimizerCycle.findMany({
            where: { target: "image" },
            orderBy: { createdAt: "desc" },
            take: AUTO_IMAGE_OPTIMIZER_LISTED_CYCLES,
            select: { id: true, createdAt: true, status: true, failure: true, optimizerModelId: true, candidateGuidance: true, summary: true, spentMicroUsd: true, promotedAt: true },
        }),
        readImageRoutingReport(1, now).catch(() => null),
        readImageRoutingReport(7, now).catch(() => null),
    ]);
    return {
        optimizerModelId,
        imageTriageOn: triageModelId !== null,
        automation,
        listedCycles: AUTO_IMAGE_OPTIMIZER_LISTED_CYCLES,
        active: { cycleId: active.cycleId, guidance: active.guidance, canRollBack: active.cycleId !== null },
        report: { day, week },
        cycles: cycles.map((cycle) => ({
            ...cycle,
            ...optimizerCycleView(cycle, now),
            promotable: imageCyclePromotable(cycle),
            createdAt: cycle.createdAt.toISOString(),
            promotedAt: cycle.promotedAt?.toISOString() ?? null,
        })),
    };
}
