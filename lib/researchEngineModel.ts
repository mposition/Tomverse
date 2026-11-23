import "server-only";

import { generateText, tool, wrapLanguageModel, type LanguageModel, type LanguageModelUsage } from "ai";
import { z } from "zod";
import type { AiModel } from "@/lib/models";
import { createTokenEstimateAccumulator, estimateTokenBreakdown, toReservedInputTokens } from "@/lib/chatTokenEstimate";
import { prisma } from "@/lib/prisma";
import { getModelGenerationSettings } from "@/lib/modelGenerationCompatibility";
import { fitChatOutputToContextWindow } from "@/lib/chatContextWindow";
import { usedResearchOutputTokens } from "@/lib/researchPreviewExecution";
import { researchExecutionProfileSchema, type ResearchModelRole } from "@/lib/researchEngineContract";
import { RESEARCH_ZERO_SETTLEMENT_USAGE, researchFundingAdapter } from "@/lib/researchEngineFunding";
import {
  beginResearchDispatch, bindResearchFundingReservation, claimResearchFundingRoom, markResearchDispatchStarted,
  markResearchDispatchUnknown, markResearchFundingUnknown, refuseResearchDispatch, releaseResearchFundingSegment,
  ResearchFundingRoomError, type ResearchItemFence,
} from "@/lib/researchEngineStore";

/**
 * The one path for every paid Research v2 model call. Order is fixed:
 * pinned identity -> estimate -> run-total room -> Chat reservation -> intent
 * -> private-scope revalidation -> dispatch_started -> one provider request
 * (no SDK retry, no continuation, one step) -> known or unknown usage.
 */

export type ResearchModelFactory = (model: AiModel) => LanguageModel;
let modelFactory: ResearchModelFactory | null = null;
export const setResearchModelFactory = (factory: ResearchModelFactory | null) => { modelFactory = factory; };
async function languageModelFor(model: AiModel) {
  if (modelFactory) return modelFactory(model);
  const { getResearchPreviewAiModel } = await import("@/lib/researchPreviewModel");
  return getResearchPreviewAiModel(model);
}

let modelResolver: ((modelId: string) => Promise<AiModel | null>) | null = null;
export const setResearchModelResolver = (resolver: typeof modelResolver) => { modelResolver = resolver; };
async function resolveRuntimeModel(modelId: string) {
  if (modelResolver) return modelResolver(modelId);
  const { getRuntimeModels } = await import("@/lib/modelRegistry");
  return (await getRuntimeModels({ includeCatalogDeleted: true })).find((model) => model.id === modelId) ?? null;
}

export class ResearchUsageUnknownError extends Error {
  constructor() { super("Research provider usage was unavailable."); this.name = "ResearchUsageUnknownError"; }
}

export type ResearchModelUsage = {
  inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; reasoningTokens: number;
};

function knownUsage(usage: LanguageModelUsage): ResearchModelUsage {
  const count = (value: number | undefined, required: boolean) => {
    if (value === undefined && !required) return 0;
    if (!Number.isSafeInteger(value) || value! < 0) throw new ResearchUsageUnknownError();
    return value!;
  };
  return {
    inputTokens: count(usage.inputTokens, true), outputTokens: count(usage.outputTokens, true),
    cachedInputTokens: count(usage.inputTokenDetails?.cacheReadTokens, false),
    cacheWriteInputTokens: count(usage.inputTokenDetails?.cacheWriteTokens, false),
    reasoningTokens: count(usage.outputTokenDetails?.reasoningTokens, false),
  };
}

export type ResearchModelCallResult<T> =
  | { ok: true; value: T; usage: ResearchModelUsage; generationId: string; segmentId: string; reservationId: string }
  | { ok: false; kind: "budget" | "backpressure" | "refused" | "profile_changed" | "scope_revoked" | "invalid_output";
      code: string; retryAfterMs?: number; generationId?: string; segmentId?: string; usage?: ResearchModelUsage }
  | { ok: false; kind: "unknown"; code: string; generationId: string; segmentId: string };

export async function callResearchModel<T>(input: {
  run: { id: string; userId: string; executionProfile: unknown };
  fence: ResearchItemFence;
  role: ResearchModelRole;
  purpose: "plan" | "work" | "finalization";
  dispatchKey: string;
  system: string;
  prompt: string;
  toolName: string;
  toolDescription: string;
  schema: z.ZodType<T>;
  outputTokenCap: number;
  /** Search vendor cost is held on this reservation for child searches requested by this output. */
  fundsSearch?: boolean;
  /** Re-checks private source grants immediately before the network. */
  revalidate?: () => Promise<boolean>;
  signal: AbortSignal;
}): Promise<ResearchModelCallResult<T>> {
  const profile = researchExecutionProfileSchema.safeParse(input.run.executionProfile);
  const pinned = profile.success ? profile.data.roles[input.role] : undefined;
  if (!pinned) return { ok: false, kind: "profile_changed", code: "RESEARCH_PROFILE_MISSING" };
  const model = await resolveRuntimeModel(pinned.modelId);
  if (!model || !model.enabled || model.catalogDeleted || model.provider !== pinned.provider || model.apiModel !== pinned.apiModel ||
      (model.reasoning ?? "provider-default") !== pinned.reasoning) {
    return { ok: false, kind: "profile_changed", code: "RESEARCH_MODEL_CHANGED" };
  }
  const schemaJson = JSON.stringify(z.toJSONSchema(input.schema as z.ZodType));
  const inputEstimate = createTokenEstimateAccumulator().addText(input.system).addText(input.prompt).addText(schemaJson).breakdown();
  const funding = await researchFundingAdapter();
  let estimate;
  try {
    estimate = await funding.estimate({ userId: input.run.userId, model, inputEstimate, outputTokenCap: input.outputTokenCap,
      searchEnabled: input.fundsSearch === true });
  } catch (error) {
    return { ok: false, kind: "refused", code: (error as { code?: string }).code ?? "RESEARCH_ESTIMATE_FAILED" };
  }
  if (estimate.pricingVersion !== pinned.pricingVersion) return { ok: false, kind: "profile_changed", code: "RESEARCH_PRICING_CHANGED" };

  let segment;
  try {
    segment = await claimResearchFundingRoom({ runId: input.run.id, purpose: input.purpose, credits: estimate.credits,
      modelId: model.id, provider: model.provider, pricingVersion: estimate.pricingVersion, fence: input.fence,
      searchSurchargeCredits: estimate.searchSurchargeCredits });
  } catch (error) {
    if (error instanceof ResearchFundingRoomError) return { ok: false, kind: "budget", code: "RESEARCH_RUN_BUDGET_REACHED" };
    throw error;
  }
  const reservation = await funding.reserve({ userId: input.run.userId, segmentId: segment.id, model, estimate,
    searchEnabled: input.fundsSearch === true });
  if (!reservation.ok) {
    await releaseResearchFundingSegment(segment.id);
    return { ok: false, kind: reservation.kind, code: reservation.code, retryAfterMs: reservation.retryAfterMs };
  }
  const releaseUnused = async () => {
    await funding.settle({ userId: input.run.userId, reservationId: reservation.reservationId, usage: RESEARCH_ZERO_SETTLEMENT_USAGE }).catch(() => undefined);
    await releaseResearchFundingSegment(segment.id);
  };
  try {
    await bindResearchFundingReservation(segment.id, reservation.reservationId, reservation.reservedCredits);
  } catch (error) {
    await releaseUnused();
    await funding.releaseLease({ userId: input.run.userId, leaseId: reservation.leaseId, segmentId: segment.id }).catch(() => undefined);
    // Recovery or expiry took this hold before the bind: nothing was sent; try again later.
    if ((error as { code?: string }).code === "RESEARCH_FUNDING_BIND_CONFLICT") return { ok: false, kind: "backpressure", code: "RESEARCH_FUNDING_BIND_CONFLICT", retryAfterMs: 1_000 };
    throw error;
  }

  let generationId: string | undefined;
  let dispatched = false;
  try {
    const begun = await beginResearchDispatch({ ...input.fence, runId: input.run.id }, {
      kind: "model", dispatchKey: input.dispatchKey, fundingSegmentId: segment.id,
      modelId: model.id, provider: model.provider, apiModel: model.apiModel, reasoning: pinned.reasoning,
      pricingVersion: estimate.pricingVersion,
    });
    generationId = begun.generation.id;
    if (begun.alreadyCompleted) { await releaseUnused(); return { ok: false, kind: "refused", code: "RESEARCH_DISPATCH_ALREADY_COMPLETED" }; }
    if (input.revalidate && !(await input.revalidate())) {
      await refuseResearchDispatch(prisma, generationId, "scope_revoked");
      await releaseUnused();
      return { ok: false, kind: "scope_revoked", code: "RESEARCH_SOURCE_REVOKED" };
    }
    const base = await languageModelFor(model);
    if (typeof base === "string") throw new Error("Research requires an explicit provider model");
    const wrapped = wrapLanguageModel({ model: base, middleware: { specificationVersion: "v4", wrapGenerate: async ({ doGenerate, params }) => {
      // Input and output share the window, and the request asks for the full
      // output cap, so both must fit; tokens come from the same estimator (and
      // margins) the reservation used, not from raw protocol bytes.
      const protocolTokens = toReservedInputTokens(estimateTokenBreakdown(JSON.stringify(params)));
      const context = fitChatOutputToContextWindow({ contextWindowTokens: model.contextWindowTokens,
        reservedInputTokens: protocolTokens, requestOutputCapTokens: input.outputTokenCap });
      if (context.kind === "exceeded" || context.outputTokens < input.outputTokenCap) throw new Error("RESEARCH_CONTEXT_EXCEEDED");
      input.signal.throwIfAborted();
      await markResearchDispatchStarted({ ...input.fence, runId: input.run.id }, generationId!);
      dispatched = true;
      return doGenerate();
    } } });
    let submitted: T | undefined;
    const result = await generateText({
      ...getModelGenerationSettings(model), reasoning: pinned.reasoning as never, model: wrapped,
      system: input.system, prompt: input.prompt, maxRetries: 0, maxOutputTokens: input.outputTokenCap,
      abortSignal: input.signal,
      tools: { [input.toolName]: tool({ description: input.toolDescription, inputSchema: input.schema as z.ZodType<T>,
        execute: async (value: T) => { submitted = value; return { status: "accepted" }; } }) },
      toolChoice: { type: "tool", toolName: input.toolName },
      stopWhen: () => true,
    });
    if (!dispatched) throw new Error("RESEARCH_DISPATCH_NOT_RECORDED");
    usedResearchOutputTokens(result.steps, model.provider);
    if (result.steps.length !== 1) throw new ResearchUsageUnknownError();
    const usage = knownUsage(result.steps[0]!.usage);
    if (usage.outputTokens > input.outputTokenCap || usage.cachedInputTokens > usage.inputTokens) throw new ResearchUsageUnknownError();
    // A missing tool call and a rejected (tool-error) call are both invalid output that still cost money.
    if (submitted === undefined) {
      return { ok: false, kind: "invalid_output", code: "RESEARCH_OUTPUT_INVALID", generationId, segmentId: segment.id, usage };
    }
    return { ok: true, value: submitted, usage, generationId, segmentId: segment.id, reservationId: reservation.reservationId };
  } catch (error) {
    if (!generationId) {
      await releaseUnused();
      // Recovery released this hold as orphaned before any intent existed: nothing was sent; try again later.
      if ((error as { code?: string }).code === "RESEARCH_FUNDING_NOT_OPEN") return { ok: false, kind: "backpressure", code: "RESEARCH_FUNDING_NOT_OPEN", retryAfterMs: 1_000 };
      throw error;
    }
    if (!dispatched) {
      await refuseResearchDispatch(prisma, generationId, "pre_dispatch");
      await releaseUnused();
      const code = (error as { code?: string }).code ?? (error instanceof Error ? error.message.slice(0, 60) : "RESEARCH_PRE_DISPATCH_FAILED");
      return { ok: false, kind: "refused", code };
    }
    await prisma.$transaction(async (tx) => {
      await markResearchDispatchUnknown(tx, generationId!);
      await markResearchFundingUnknown(tx, segment.id, { usageFromProvider: false, outcome: "failed", searchQueriesObserved: false });
    });
    return { ok: false, kind: "unknown", code: error instanceof ResearchUsageUnknownError ? "RESEARCH_USAGE_UNKNOWN" : "RESEARCH_OUTCOME_UNKNOWN",
      generationId, segmentId: segment.id };
  } finally {
    await funding.releaseLease({ userId: input.run.userId, leaseId: reservation.leaseId, segmentId: segment.id }).catch(() => undefined);
  }
}

/** Invalid structured output still cost money: complete the dispatch with its known usage. */
export async function recordInvalidResearchOutput(generationId: string, usage: ResearchModelUsage) {
  await prisma.researchPreviewGeneration.updateMany({ where: { id: generationId, status: "dispatch_started" },
    data: { status: "completed", completedAt: new Date(), inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens,
      reasoningTokens: usage.reasoningTokens, stopReason: "invalid_report" } });
}
