import "server-only";

import { generateText, jsonSchema, Output } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import { getActiveAiModel } from "@/lib/activeAiModel";
import { reserveRouterCost, settleRouterCost } from "@/lib/autoLlmRouter";
import {
  autoLlmRouterProviderOptions,
  autoLlmRouterWorstCaseMicroUsd,
  resolveAutoLlmRouterModel,
} from "@/lib/autoLlmRouterCore";
import { readAutoLlmRouterModelId } from "@/lib/autoLlmRouterSettings";
import { callCostMicroUsd } from "@/lib/autoRouterOptimizerCore";
import { helpCentreCopy } from "@/lib/helpCentre/copy";
import {
  HELP_ASSISTANT_MAX_OUTPUT_TOKENS,
  HELP_ASSISTANT_TIMEOUT_MS,
  helpAssistantOutputSchema,
  helpAssistantPrompt,
  helpAssistantSystem,
  parseHelpAssistantOutput,
  type HelpAssistantAnswer,
  type HelpAssistantTurn,
} from "@/lib/helpAssistantCore";
import type { Language } from "@/lib/language";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { resolveModelPricing } from "@/lib/modelPricing";

export type HelpAssistantResult =
  | { ok: true; answer: HelpAssistantAnswer }
  | { ok: false; reason: "no_model" | "unpriced" | "provider_budget" | "error" };

/**
 * One help answer: the Auto router's model (Admin Console > Routing), given the
 * reader's-language help guides and the question, nothing else.
 *
 * Paid from the platform, not from the reader's credits (owner decision
 * 2026-11-18, no per-reader daily limit). The worst case is held under the
 * provider's operational day/month budget before the call leaves, exactly like
 * the image-intent call, and settled to the reported usage afterwards; a call
 * that fails or times out keeps its whole hold because it may still have been
 * billed. The log line carries ids, outcome and timing, never the question.
 */
export async function answerHelpQuestion(input: {
  lang: Language;
  question: string;
  history: readonly HelpAssistantTurn[];
  focusGuideId: string | null;
  traceId: string;
}): Promise<HelpAssistantResult> {
  const configured = await readAutoLlmRouterModelId();
  if (!configured) return { ok: false, reason: "no_model" };
  let model;
  let prices: { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number };
  try {
    const runtimeModels = await getRuntimeModels();
    model = resolveAutoLlmRouterModel(
      runtimeModels.filter((entry) => entry.enabled && !entry.catalogDeleted),
      configured
    );
    if (!model) return { ok: false, reason: "no_model" };
    const pricing = resolveModelPricing(model);
    prices = {
      inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
    };
  } catch {
    return { ok: false, reason: "no_model" };
  }

  const copy = helpCentreCopy(input.lang);
  const system = helpAssistantSystem(input.lang, copy, input.focusGuideId);
  const prompt = helpAssistantPrompt(input.question, input.history);
  const maxOutputTokens = HELP_ASSISTANT_MAX_OUTPUT_TOKENS;
  const worstCase = autoLlmRouterWorstCaseMicroUsd({ system, prompt, maxOutputTokens, ...prices });
  const reservedAt = new Date();
  if (worstCase === null) return log(input, model.id, "unpriced", 0, { ok: false, reason: "unpriced" });
  if (!(await reserveRouterCost(model.provider, worstCase, reservedAt))) {
    return log(input, model.id, "provider_budget", 0, { ok: false, reason: "provider_budget" });
  }

  const startedAt = Date.now();
  try {
    const generated = await generateText({
      model: getActiveAiModel(model),
      system,
      prompt,
      maxOutputTokens,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(HELP_ASSISTANT_TIMEOUT_MS),
      output: Output.object({
        schema: jsonSchema(helpAssistantOutputSchema() as unknown as JSONSchema7),
        name: "help_answer",
      }),
      providerOptions: autoLlmRouterProviderOptions(model.provider),
    });
    const usage = generated.usage as { inputTokens?: number; outputTokens?: number } | undefined;
    if (usage?.inputTokens !== undefined && usage.outputTokens !== undefined) {
      const actual = callCostMicroUsd({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...prices });
      void settleRouterCost(model.provider, actual - worstCase, reservedAt);
    }
    const answer = parseHelpAssistantOutput(generated.output, copy.ui.notFound);
    return log(input, model.id, answer.status, Date.now() - startedAt, { ok: true, answer });
  } catch {
    return log(input, model.id, "error", Date.now() - startedAt, { ok: false, reason: "error" });
  }
}

function log<T extends HelpAssistantResult>(
  input: { lang: Language; focusGuideId: string | null; traceId: string; history: readonly unknown[] },
  modelId: string,
  outcome: string,
  latencyMs: number,
  result: T
): T {
  console.info(
    JSON.stringify({
      event: "help_assistant",
      traceId: input.traceId,
      modelId,
      lang: input.lang,
      outcome,
      focusGuideId: input.focusGuideId,
      followUp: input.history.length > 0,
      guideIds: result.ok && result.answer.status === "answered" ? result.answer.guideIds : [],
      latencyMs,
    })
  );
  return result;
}
