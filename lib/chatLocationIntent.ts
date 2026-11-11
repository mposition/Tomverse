import "server-only";
import { generateText, Output } from "ai";
import { z } from "zod";
import { getActiveAiModel } from "@/lib/activeAiModel";
import { reserveRouterCost, settleRouterCost } from "@/lib/autoLlmRouter";
import { autoLlmRouterProviderOptions, autoLlmRouterWorstCaseMicroUsd, resolveAutoLlmRouterModel } from "@/lib/autoLlmRouterCore";
import { readAutoLlmRouterModelId } from "@/lib/autoLlmRouterSettings";
import { callCostMicroUsd } from "@/lib/autoRouterOptimizerCore";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { resolveModelPricing } from "@/lib/modelPricing";

import { CHAT_LOCATION_INTENT_PROMPT } from "./chatLocationIntentPrompt";
export { CHAT_LOCATION_INTENT_PROMPT } from "./chatLocationIntentPrompt";
const schema = z.object({ requiresLocation: z.boolean() }).strict();

/** No keyword rules, new provider or spending ceiling. Off/unavailable fails to ordinary chat. */
export async function detectChatLocationIntent(text: string): Promise<boolean> {
  let reserved: { provider: string; worst: number; at: Date } | undefined;
  try {
    if (process.env.TOMVERSE_CHAT_LOCATION_INTENT_ENABLED !== "true") return false;
    const configured = await readAutoLlmRouterModelId();
    if (!configured) return false;
    const models = await getRuntimeModels();
    const model = resolveAutoLlmRouterModel(models.filter(item => item.enabled && !item.catalogDeleted), configured);
    if (!model) return false;
    const pricing = resolveModelPricing(model);
    const prices = { inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens };
    const prompt = JSON.stringify({ userMessage: text.slice(0, 8_000) });
    const maxOutputTokens = 400;
    const worst = autoLlmRouterWorstCaseMicroUsd({ system: CHAT_LOCATION_INTENT_PROMPT, prompt, maxOutputTokens, ...prices });
    const at = new Date();
    if (worst === null || !(await reserveRouterCost(model.provider, worst, at))) return false;
    reserved = { provider: model.provider, worst, at };
    const result = await generateText({ model: getActiveAiModel(model), system: CHAT_LOCATION_INTENT_PROMPT,
      prompt, maxOutputTokens, maxRetries: 0, abortSignal: AbortSignal.timeout(8_000),
      output: Output.object({ schema }), providerOptions: autoLlmRouterProviderOptions(model.provider) });
    const usage = result.usage;
    if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
      const actual = callCostMicroUsd({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...prices });
      await settleRouterCost(reserved.provider, actual - reserved.worst, reserved.at).catch(() => undefined);
    }
    const parsed = schema.safeParse(result.output);
    return parsed.success && parsed.data.requiresLocation;
  } catch {
    // Unknown provider outcomes keep their worst-case hold. No prompt or fix is logged.
    return false;
  }
}
