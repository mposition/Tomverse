/**
 * One LLM call per scout subject: the screenshots and signals of one page,
 * generated file or the catalogue in, up to five improvement suggestions out.
 * The same shape as the support-triage model step: build
 * the prompt, call once, validate the answer.
 *
 * The model is the one an owner chose in Admin (lib/productResearchScoutSettings.ts);
 * no model means the step is off and nothing is spent. Each call is taken from
 * the daily cap before it runs, uses `maxRetries: 0` and the output cap below,
 * and logs its token counts, never content.
 */
import "server-only";

import { generateText, jsonSchema, Output } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";

import { getActiveAiModel } from "@/lib/activeAiModel";
import { getEnabledRuntimeModel, getRuntimeModels } from "@/lib/modelRegistry";
import { modelSupportsImageInput } from "@/lib/models";
import {
  SCOUT_OUTPUT_SCHEMA,
  SCOUT_SYSTEM_PROMPT,
  parseScoutAnswer,
  scoutPromptText,
  type ScoutSubmission,
  type ScoutSuggestion,
} from "@/lib/productResearchScoutCore";

export const SCOUT_LLM_MAX_OUTPUT_TOKENS = 2_000;
export const SCOUT_LLM_TIMEOUT_MS = 90_000;

export type ScoutModelOption = { readonly id: string; readonly name: string; readonly provider: string };

/** The models an owner may choose: enabled, in the catalogue, and able to read images. */
export async function scoutModelOptions(): Promise<ScoutModelOption[]> {
  return (await getRuntimeModels())
    .filter((model) => model.enabled && !model.catalogDeleted && modelSupportsImageInput(model))
    .map((model) => ({ id: model.id, name: model.name, provider: model.provider }));
}

export type ScoutJudgement = {
  /** Null when the call failed or its answer could not be read. */
  readonly suggestions: ScoutSuggestion[] | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
};

export type ScoutLlm = {
  readonly modelId: string;
  readonly judge: (submission: ScoutSubmission, existingTitles: readonly string[]) => Promise<ScoutJudgement>;
};

/** The chosen model, or null when none is chosen or it can no longer read images. */
export async function scoutLlmFor(modelId: string | null): Promise<ScoutLlm | null> {
  if (!modelId) return null;
  const model = await getEnabledRuntimeModel(modelId);
  if (!model || !modelSupportsImageInput(model)) {
    console.warn(JSON.stringify({ event: "product_research_scout_llm_model_unavailable" }));
    return null;
  }
  return {
    modelId: model.id,
    judge: async (submission, existingTitles) => {
      try {
        const generated = await generateText({
          model: getActiveAiModel(model),
          system: SCOUT_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: scoutPromptText(submission, existingTitles) },
                ...submission.images.map((image) => ({
                  type: "image" as const,
                  image: image.base64,
                  mediaType: image.mediaType,
                })),
              ],
            },
          ],
          maxOutputTokens: SCOUT_LLM_MAX_OUTPUT_TOKENS,
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(SCOUT_LLM_TIMEOUT_MS),
          output: Output.object({
            schema: jsonSchema(SCOUT_OUTPUT_SCHEMA as unknown as JSONSchema7),
            name: "product_research_scout",
          }),
          providerOptions: { openai: { strictJsonSchema: true } },
        });
        const usage = generated.usage as { inputTokens?: number; outputTokens?: number } | undefined;
        const suggestions = parseScoutAnswer(generated.output, existingTitles);
        const judgement = {
          suggestions,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
        };
        console.info(
          JSON.stringify({
            event: "product_research_scout_llm_call",
            modelId: model.id,
            subject: submission.subject,
            inputTokens: judgement.inputTokens,
            outputTokens: judgement.outputTokens,
            kept: suggestions.length,
          }),
        );
        return judgement;
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "product_research_scout_llm_call_failed",
            modelId: model.id,
            subject: submission.subject,
            error: error instanceof Error ? error.name : "unknown",
          }),
        );
        return { suggestions: null, inputTokens: null, outputTokens: null };
      }
    },
  };
}
