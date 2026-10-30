import "server-only";

import { createHash } from "node:crypto";

import { generateText, jsonSchema, Output } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";

import { getActiveAiModel } from "@/lib/activeAiModel";
import { reserveRouterCost, settleRouterCost } from "@/lib/autoLlmRouter";
import { autoLlmRouterProviderOptions, autoLlmRouterWorstCaseMicroUsd,
  resolveAutoLlmRouterModel } from "@/lib/autoLlmRouterCore";
import { readAutoLlmRouterModelId } from "@/lib/autoLlmRouterSettings";
import { callCostMicroUsd } from "@/lib/autoRouterOptimizerCore";
import { AMUX_ANALYSIS_TRANSLATION_ENV, AMUX_ANALYSIS_TRANSLATION_MAX_OUTPUT_TOKENS,
  AMUX_ANALYSIS_TRANSLATION_SYSTEM, AMUX_ANALYSIS_TRANSLATION_TIMEOUT_MS,
  amuxAnalysisTranslationEnabled, amuxTranslationOutputSchema, amuxTranslationPrompt,
  checkAmuxTranslationSource, parseAmuxTranslationOutput,
  type AmuxTranslationItem } from "@/lib/amux/ideaAnalysisTranslationCore";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { resolveModelPricing } from "@/lib/modelPricing";

export type AmuxTranslationOutcome =
  | { state: "translated"; translations: Record<string, string>; cached: boolean }
  | { state: "disabled" | "empty" | "too_large" | "unavailable" };

// The same text translated by the same model is answered from memory: a
// reload, a second tab or the owner toggling the view makes no second call.
// Memory, not a table, because a lost cache costs one cent, not a migration.
const CACHE_LIMIT = 200;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; translations: Record<string, string> }>();

const cacheKey = (modelId: string, items: readonly AmuxTranslationItem[]) =>
  createHash("sha256").update(JSON.stringify([modelId, AMUX_ANALYSIS_TRANSLATION_SYSTEM, items]))
    .digest("hex");

const cached = (key: string, now: number) => {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  if (now - hit.at > CACHE_TTL_MS) return null;
  cache.set(key, hit);
  return hit.translations;
};

const remember = (key: string, now: number, translations: Record<string, string>) => {
  cache.set(key, { at: now, translations });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
};

/** For tests: a fresh process. */
export const clearAmuxTranslationCache = () => cache.clear();

/**
 * Translates the given English texts into Korean with the Auto router's
 * configured model, under the provider's operational budget (the hold path
 * chat routing uses, docs/policy/credit-and-cost-limits.md). It reaches no
 * user credits. Never throws; every failure is "unavailable" and nothing
 * from the source is logged.
 */
export async function translateAmuxItemsToKorean(
  items: AmuxTranslationItem[],
): Promise<AmuxTranslationOutcome> {
  if (!amuxAnalysisTranslationEnabled(process.env[AMUX_ANALYSIS_TRANSLATION_ENV])) {
    return { state: "disabled" };
  }
  const source = checkAmuxTranslationSource(items);
  if (!source.ok) return { state: source.code };
  try {
    const configured = await readAutoLlmRouterModelId();
    if (!configured) return { state: "unavailable" };
    const models = await getRuntimeModels();
    const model = resolveAutoLlmRouterModel(
      models.filter((item) => item.enabled && !item.catalogDeleted), configured);
    if (!model) return { state: "unavailable" };
    const key = cacheKey(model.id, source.items);
    const now = Date.now();
    const hit = cached(key, now);
    if (hit) return { state: "translated", translations: hit, cached: true };

    const pricing = resolveModelPricing(model);
    const prices = { inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens };
    const prompt = amuxTranslationPrompt(source.items);
    const maxOutputTokens = AMUX_ANALYSIS_TRANSLATION_MAX_OUTPUT_TOKENS;
    const worst = autoLlmRouterWorstCaseMicroUsd({ system: AMUX_ANALYSIS_TRANSLATION_SYSTEM,
      prompt, maxOutputTokens, ...prices });
    const at = new Date();
    if (worst === null || !(await reserveRouterCost(model.provider, worst, at))) {
      return { state: "unavailable" };
    }
    const result = await generateText({ model: getActiveAiModel(model),
      system: AMUX_ANALYSIS_TRANSLATION_SYSTEM, prompt, maxOutputTokens, maxRetries: 0,
      abortSignal: AbortSignal.timeout(AMUX_ANALYSIS_TRANSLATION_TIMEOUT_MS),
      output: Output.object({ schema: jsonSchema(amuxTranslationOutputSchema as unknown as JSONSchema7),
        name: "korean_translation" }),
      providerOptions: autoLlmRouterProviderOptions(model.provider) });
    const usage = result.usage;
    if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
      const actual = callCostMicroUsd({ inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens, ...prices });
      await settleRouterCost(model.provider, actual - worst, at).catch(() => undefined);
    }
    const translations = parseAmuxTranslationOutput(result.output, source.items);
    if (!translations) return { state: "unavailable" };
    remember(key, now, translations);
    return { state: "translated", translations, cached: false };
  } catch {
    // An unknown provider outcome keeps its worst-case hold and is not retried here.
    return { state: "unavailable" };
  }
}
