/**
 * One LLM call per scout subject: the screenshots and signals of one page,
 * generated file or the catalogue in, up to five improvement suggestions out.
 * The same shape as the support-triage step (lib/supportTriageLlm.ts): build
 * the prompt, call once, validate the answer.
 *
 * Off unless PRODUCT_RESEARCH_SCOUT_LLM_MODEL_ID names an enabled runtime model
 * that accepts images; then nothing is spent. Spend is bounded by the walker:
 * one call per subject, about thirty subjects a day, `maxRetries: 0`, the
 * output cap below. Each call logs its token counts, never content.
 */
import "server-only";

import { generateText, jsonSchema, Output } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";

import { getActiveAiModel } from "@/lib/activeAiModel";
import { getEnabledRuntimeModel } from "@/lib/modelRegistry";
import { modelSupportsImageInput } from "@/lib/models";
import {
  SCOUT_OUTPUT_SCHEMA,
  SCOUT_SYSTEM_PROMPT,
  parseScoutAnswer,
  scoutPromptText,
  type ScoutSubmission,
  type ScoutSuggestion,
} from "@/lib/productResearchScoutCore";

export const PRODUCT_RESEARCH_SCOUT_LLM_MODEL_ENV = "PRODUCT_RESEARCH_SCOUT_LLM_MODEL_ID";
export const SCOUT_LLM_MAX_OUTPUT_TOKENS = 2_000;
export const SCOUT_LLM_TIMEOUT_MS = 90_000;

export type ScoutLlm = {
  readonly modelId: string;
  readonly judge: (submission: ScoutSubmission, existingTitles: readonly string[]) => Promise<ScoutSuggestion[] | null>;
};

/** The configured model, or null when the scout's model step is off. */
export const productResearchScoutLlmFromEnv = async (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ScoutLlm | null> => {
  const modelId = env[PRODUCT_RESEARCH_SCOUT_LLM_MODEL_ENV]?.trim();
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
        console.info(
          JSON.stringify({
            event: "product_research_scout_llm_call",
            modelId: model.id,
            subject: submission.subject,
            inputTokens: usage?.inputTokens ?? null,
            outputTokens: usage?.outputTokens ?? null,
            kept: suggestions.length,
          }),
        );
        return suggestions;
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "product_research_scout_llm_call_failed",
            modelId: model.id,
            subject: submission.subject,
            error: error instanceof Error ? error.name : "unknown",
          }),
        );
        return null;
      }
    },
  };
};
