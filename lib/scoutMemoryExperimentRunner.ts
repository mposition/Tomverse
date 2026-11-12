import "server-only";
import { generateText } from "ai";
import { getActiveAiModel } from "./activeAiModel";
import { getEnabledRuntimeModel } from "./modelRegistry";
import { modelSupportsImageInput } from "./models";
import {
  readScoutSettings,
  startScoutCall,
  settleScoutCall,
} from "./productResearchScoutSettings";
import { resolveModelPricing } from "./modelPricing";
import { calculateProviderUsageCost } from "./providerUsageCost";
import { storeMemoryTrial } from "./scoutMemoryExperimentStore";
import {
  experimentCase,
  dailyScenario,
  armProbe,
  scoreArm,
  EXPERIMENT_VERSION,
  type Arm,
} from "./scoutMemoryExperiment";
import { rankSyntheticDocuments, rankMicroUsd } from "./scoutMemoryCohere";
import type { MemoryProbeLocale } from "./productResearchScoutMemoryCases";

export const comparisonEnabled = () =>
  process.env.PRODUCT_RESEARCH_SCOUT_MEMORY_COMPARISON_ENABLED === "1";
export async function sampleMemoryTrial(
  locale: MemoryProbeLocale,
  arm: Arm,
  day: string,
) {
  const { modelId } = await readScoutSettings();
  if (!modelId) return { judged: false, reason: "model_off" };
  const model = await getEnabledRuntimeModel(modelId);
  if (!model || !modelSupportsImageInput(model))
    return { judged: false, reason: "model_off" };
  const scenario = dailyScenario(day, locale),
    c = experimentCase(day, locale, scenario);
  const base = "memory.continuation.compare." + locale + ".";
  const key =
    process.env.PRODUCT_RESEARCH_SCOUT_COHERE_API_KEY ||
    process.env.COHERE_API_KEY;
  if (arm === "cohere" && !key)
    return { judged: false, reason: "cohere_key_missing" };
  const start = performance.now();
  let ranking: Awaited<ReturnType<typeof rankSyntheticDocuments>> | undefined;
  if (arm === "cohere") {
    const reservation = await startScoutCall({
      modelId,
      subject: base + "rank",
      onceOnUtcDay: day,
      keepFree: 1,
      rerank: true,
    });
    if ("refused" in reservation)
      return { judged: false, reason: reservation.refused };
    try {
      ranking = await rankSyntheticDocuments(
        key!,
        c.source.question,
        c.documents,
      );
    } catch {
      await settleScoutCall(reservation.id, {
        ok: false,
        inputTokens: null,
        outputTokens: null,
        kept: null,
      });
      return { judged: false, reason: "rerank_failed" };
    }
    await settleScoutCall(reservation.id, {
      ok: true,
      inputTokens: ranking.billedTokens,
      outputTokens: 0,
      kept: 0,
    });
  }
  const probe = armProbe(c, arm, ranking?.indices);
  const ready = performance.now();
  const grant = await startScoutCall({
    modelId,
    subject: base + arm,
    onceOnUtcDay: day,
  });
  if ("refused" in grant) return { judged: false, reason: grant.refused };
  let result;
  try {
    result = await generateText({
      model: getActiveAiModel(model),
      messages: probe.messages,
      maxOutputTokens: 512,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(60_000),
    });
  } catch {
    await settleScoutCall(grant.id, {
      ok: false,
      inputTokens: null,
      outputTokens: null,
      kept: null,
    });
    return { judged: false, reason: "model_failed" };
  }
  const end = performance.now();
  const { inputTokens, outputTokens, inputTokenDetails } = result.usage;
  const rates = resolveModelPricing(model, {
    estimatedPromptTokens: inputTokens ?? 0,
  });
  const knownRates =
    !rates.isFallbackPricing ||
    (model.inputUsdPerMillionTokens != null &&
      model.outputUsdPerMillionTokens != null);
  const pricing =
    knownRates && inputTokens != null && outputTokens != null
      ? calculateProviderUsageCost({
          inputTokens,
          outputTokens,
          cachedInputTokens: inputTokenDetails?.cacheReadTokens,
          cacheWriteInputTokens: inputTokenDetails?.cacheWriteTokens,
          inputUsdPerMillionTokens: rates.inputUsdPerMillionTokens,
          outputUsdPerMillionTokens: rates.outputUsdPerMillionTokens,
          cachedInputPriceMultiplier: rates.cachedInputPriceMultiplier,
          cacheWriteUsdPerMillionTokens: rates.cacheWriteUsdPerMillionTokens,
        })
      : null;
  const ambiguousCache =
    !!inputTokenDetails?.cacheReadTokens &&
    !rates.cachedInputPricingVerified &&
    model.cachedInputPriceMultiplier == null;
  await storeMemoryTrial(
    {
      ...scoreArm(c, probe, result.text),
      version: EXPERIMENT_VERSION,
      day,
      locale,
      scenario,
      arm,
      model: modelId,
      sourceDigest: c.digest,
      elapsedMs: Math.round(end - start),
      retrievalMs: Math.round(ready - start),
      answerMs: Math.round(end - ready),
      inputTokens: inputTokens ?? null,
      outputTokens: outputTokens ?? null,
      rerankTokens: ranking ? ranking.billedTokens : 0,
      answerMicroUsd:
        pricing && !pricing.unpricedCacheWriteTokens && !ambiguousCache
          ? pricing.totalCostMicroUsd
          : null,
      retrievalMicroUsd: ranking ? rankMicroUsd(ranking.billedTokens) : 0,
      measuredAt: new Date().toISOString(),
    },
    grant.id,
  );
  return { judged: true, stored: 0 };
}
