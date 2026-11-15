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
  mergeAmuxTranslation, parseAmuxTranslationOutput, planAmuxTranslation,
  type AmuxTranslationItem } from "@/lib/amux/ideaAnalysisTranslationCore";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { resolveModelPricing } from "@/lib/modelPricing";

export type AmuxTranslationOutcome =
  | { state: "translated"; translations: Record<string, string>; cached: boolean;
      /** Provider requests this translation sent; a cached call sends none. */
      calls: number }
  | { state: "unavailable"; calls: number }
  | { state: "disabled" | "empty" | "too_large" };

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

type RouterModel = NonNullable<ReturnType<typeof resolveAutoLlmRouterModel>>;

/** One call of the plan: its own worst-case hold, request and settlement.
 * `made.calls` counts every request sent to the provider, failed ones too. */
async function translateOneCall(model: RouterModel, items: AmuxTranslationItem[],
  made: { calls: number }):
  Promise<{ translations: Record<string, string>; cached: boolean } | null> {
  const key = cacheKey(model.id, items);
  const now = Date.now();
  const hit = cached(key, now);
  if (hit) return { translations: hit, cached: true };
  const pricing = resolveModelPricing(model);
  const prices = { inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens };
  const prompt = amuxTranslationPrompt(items);
  const maxOutputTokens = AMUX_ANALYSIS_TRANSLATION_MAX_OUTPUT_TOKENS;
  const worst = autoLlmRouterWorstCaseMicroUsd({ system: AMUX_ANALYSIS_TRANSLATION_SYSTEM,
    prompt, maxOutputTokens, ...prices });
  const at = new Date();
  if (worst === null || !(await reserveRouterCost(model.provider, worst, at))) return null;
  made.calls += 1;
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
  const translations = parseAmuxTranslationOutput(result.output, items);
  if (!translations) return null;
  remember(key, now, translations);
  return { translations, cached: false };
}

/**
 * Translates the given English texts into Korean with the Auto router's
 * configured model, under the provider's operational budget (the hold path
 * chat routing uses, docs/policy/credit-and-cost-limits.md). It reaches no
 * user credits. A page larger than one call is translated in calls of one
 * call's size, one after another (planAmuxTranslation); each call holds,
 * requests and settles exactly as a single call does, and a call the budget
 * refuses ends the request. Never throws; every failure is "unavailable" and
 * nothing from the source is logged.
 */
export async function translateAmuxItemsToKorean(
  items: AmuxTranslationItem[],
): Promise<AmuxTranslationOutcome> {
  if (!amuxAnalysisTranslationEnabled(process.env[AMUX_ANALYSIS_TRANSLATION_ENV])) {
    return { state: "disabled" };
  }
  const planned = planAmuxTranslation(items);
  if (!planned.ok) return { state: planned.code };
  const made = { calls: 0 };
  try {
    const configured = await readAutoLlmRouterModelId();
    if (!configured) return { state: "unavailable", calls: 0 };
    const models = await getRuntimeModels();
    const model = resolveAutoLlmRouterModel(
      models.filter((item) => item.enabled && !item.catalogDeleted), configured);
    if (!model) return { state: "unavailable", calls: 0 };
    const translated: Record<string, string> = {};
    let allCached = true;
    for (const batch of planned.plan.batches) {
      // A finished call stays cached, so asking again pays only for the rest.
      const outcome = await translateOneCall(model, batch, made);
      if (!outcome) return { state: "unavailable", calls: made.calls };
      allCached &&= outcome.cached;
      Object.assign(translated, outcome.translations);
    }
    const translations = mergeAmuxTranslation(planned.plan, translated);
    if (!translations) return { state: "unavailable", calls: made.calls };
    return { state: "translated", translations, cached: allCached, calls: made.calls };
  } catch {
    // An unknown provider outcome keeps its worst-case hold and is not retried here.
    return { state: "unavailable", calls: made.calls };
  }
}
