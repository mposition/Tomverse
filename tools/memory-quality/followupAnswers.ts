import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type ModelMessage } from "ai";
import { z } from "zod";
import { splitProviderInstructions } from "../../lib/chatProviderPrompt";
import { getModel } from "../../lib/models";
import { getModelGenerationSettings } from "../../lib/modelGenerationCompatibility";
import { resolveModelPricing } from "../../lib/modelPricing";
import { PROVIDER_API_CONFIGURATION } from "../../lib/modelRegistryShared";
import { FOLLOWUP_ANSWERS_FORMAT, FOLLOWUP_CONDITIONS, followupAnswersSchema, type FollowupAnswers } from "./followupSchema";
import { QualityStop } from "./runner";
import { digest } from "./schema";
import { SaveTarget, type LiveContext } from "./semanticLive";

/**
 * PAID: generates the answers `followup-eval` imports, one provider call per
 * distinct message list in `answer-requests.json`.
 *
 * The model and its generation settings are the product's own (`lib/models.ts`,
 * `getModelGenerationSettings`); only the key comes from this process. Guards,
 * all checked before the first request: an explicit call ceiling and a USD
 * ceiling at or above the plan's worst case, a new save file rewritten after
 * every answer, no retry of a failed call (its cost is unknown, so it is
 * charged at its worst case), and the key never printed or written.
 */
export const FOLLOWUP_ANSWER_MODEL = "gpt-6-luna";
export const FOLLOWUP_ANSWER_MAX_OUTPUT_TOKENS = 4_096;
const TIMEOUT_MS = 180_000;

const requestsFile = z.object({
  format: z.literal("memory-followup-answer-requests-v1"), bundleId: z.string(), evalDigest: z.string(),
  requests: z.array(z.object({
    caseId: z.string(), condition: z.enum(FOLLOWUP_CONDITIONS), promptVersion: z.string(), messagesDigest: z.string(),
    messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() }).strict()).min(1),
  }).passthrough()).min(1),
}).passthrough();
type AnswerRequest = z.infer<typeof requestsFile>["requests"][number];

const positive = (raw: string | undefined, missing: string, invalid: string) => {
  if (raw === undefined) throw new QualityStop(missing);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new QualityStop(invalid);
  return value;
};

type ErrorShape = { name?: string; statusCode?: number; lastError?: unknown; cause?: unknown } | null;
const failureOf = (error: unknown): string => {
  const shape = error as ErrorShape;
  // The SDK may wrap the provider error (RetryError.lastError, cause); read the status where it is.
  const status = shape?.statusCode ?? (shape?.lastError as ErrorShape)?.statusCode ?? (shape?.cause as ErrorShape)?.statusCode;
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status !== undefined) return "provider_error";
  return shape?.name === "TimeoutError" || shape?.name === "AbortError" ? "timeout" : "provider_error";
};

async function loadRequests(file: string) {
  let parsed: z.infer<typeof requestsFile>;
  try {
    parsed = requestsFile.parse(JSON.parse(await readFile(resolve(file), "utf8")));
  } catch {
    throw new QualityStop("answer_requests_invalid");
  }
  // What is sent must be what the digest names: followup-eval matches answers by it.
  for (const row of parsed.requests) {
    if (digest(row.messages) !== row.messagesDigest) throw new QualityStop("answer_requests_digest_mismatch");
  }
  return parsed;
}

export async function collectFollowupAnswers(options: Record<string, string>, context: LiveContext) {
  if (options.live !== "true") throw new QualityStop("live_required");
  if (!options.requests) throw new QualityStop("answer_requests_required");
  const maxCalls = positive(options["max-calls"], "max_calls_required", "max_calls_invalid");
  if (!Number.isSafeInteger(maxCalls)) throw new QualityStop("max_calls_invalid");
  const maxUsd = positive(options["max-usd"], "max_usd_required", "max_usd_invalid");
  const save = options["save-answers"];
  if (!save) throw new QualityStop("save_answers_required");

  const env = context.env ?? process.env;
  const apiKey = env[PROVIDER_API_CONFIGURATION.openai.apiKeyEnvName]?.trim();
  if (!apiKey) throw new QualityStop("live_env_missing");
  const model = getModel(FOLLOWUP_ANSWER_MODEL);
  if (!model) throw new QualityStop("answer_model_unknown");
  const pricing = resolveModelPricing(model, { estimatedPromptTokens: 10_000 });

  const file = await loadRequests(options.requests);
  const kind = context.fetchImpl ? "mock" as const : "provider" as const;
  // One call per distinct message list; every request row with that digest gets its answer.
  const distinct = new Map<string, AnswerRequest>();
  for (const row of file.requests) if (!distinct.has(row.messagesDigest)) distinct.set(row.messagesDigest, row);

  const texts = new Map<string, string>();
  if (options["resume-answers"]) {
    let prior: FollowupAnswers;
    try {
      prior = followupAnswersSchema.parse(JSON.parse(await readFile(resolve(options["resume-answers"]), "utf8")));
    } catch {
      throw new QualityStop("resume_answers_invalid");
    }
    if (prior.bundleId !== file.bundleId || prior.evalDigest !== file.evalDigest || prior.generator.kind !== kind ||
        prior.generator.model !== model.id) throw new QualityStop("resume_answers_mismatch");
    for (const row of prior.answers) {
      if (!distinct.has(row.messagesDigest)) throw new QualityStop("resume_answers_mismatch");
      texts.set(row.messagesDigest, row.text);
    }
  }
  const pending = [...distinct.values()].filter((row) => !texts.has(row.messagesDigest));
  if (pending.length === 0) throw new QualityStop("nothing_to_answer");
  if (pending.length > maxCalls) throw new QualityStop("max_calls_below_planned");
  // Worst case: every character a token (more than any tokenizer gives) plus the full output allowance.
  const worstUsd = (row: AnswerRequest) => (row.messages.reduce((sum, message) => sum + message.content.length, 0) *
    pricing.inputUsdPerMillionTokens + FOLLOWUP_ANSWER_MAX_OUTPUT_TOKENS * pricing.outputUsdPerMillionTokens) / 1_000_000;
  const plannedWorstUsd = pending.reduce((sum, row) => sum + worstUsd(row), 0);
  if (plannedWorstUsd > maxUsd) throw new QualityStop("max_usd_below_planned");

  const provider = createOpenAI({
    baseURL: PROVIDER_API_CONFIGURATION.openai.baseUrl, apiKey,
    ...(context.fetchImpl ? { fetch: context.fetchImpl } : {}),
  });
  const settings = getModelGenerationSettings(model);
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, usageUnreported: 0,
    truncated: 0, unknownCostCalls: 0, spentUsd: 0 };
  const collectedAt = new Date().toISOString();
  const snapshot = (complete: boolean): FollowupAnswers => ({
    format: FOLLOWUP_ANSWERS_FORMAT, bundleId: file.bundleId, evalDigest: file.evalDigest,
    generator: { kind, provider: "openai", model: model.id, collectedAt, settings: {
      apiModel: model.apiModel, reasoningEffort: model.reasoning ?? null,
      maxOutputTokens: FOLLOWUP_ANSWER_MAX_OUTPUT_TOKENS, samplesPerMessage: 1, retries: 0,
      pricingVersion: pricing.pricingVersion ?? null, maxCalls, maxUsd, complete,
      ...usage, spentUsd: Math.round(usage.spentUsd * 1e6) / 1e6,
    } },
    answers: file.requests.filter((row) => texts.has(row.messagesDigest)).map((row) => ({
      caseId: row.caseId, condition: row.condition, messagesDigest: row.messagesDigest,
      promptVersion: row.promptVersion, text: texts.get(row.messagesDigest)!,
    })),
  });
  const target = await SaveTarget.claim(save, snapshot(false)).catch((error: unknown) => {
    throw error instanceof QualityStop ? new QualityStop(error.code.replace("save_scores", "save_answers")) : error;
  });
  let stop: { stopReason: string; failure: string | null } | null = null;
  try {
    for (const row of pending) {
      if (usage.calls >= maxCalls) { stop = { stopReason: "max_calls_reached", failure: null }; break; }
      if (usage.spentUsd + worstUsd(row) > maxUsd) { stop = { stopReason: "max_usd_reached", failure: null }; break; }
      usage.calls += 1;
      let generated: Awaited<ReturnType<typeof generateText>>;
      try {
        // The chat route's split: system blocks become instructions, the rest stays as messages.
        generated = await generateText({
          model: provider(model.apiModel), ...splitProviderInstructions(row.messages as ModelMessage[]), ...settings,
          maxOutputTokens: FOLLOWUP_ANSWER_MAX_OUTPUT_TOKENS, maxRetries: 0, abortSignal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        // Sent and possibly billed: charged at its worst case and never retried.
        usage.unknownCostCalls += 1;
        usage.spentUsd += worstUsd(row);
        stop = { stopReason: "live_call_failed", failure: failureOf(error) };
        break;
      }
      const inputTokens = generated.usage.inputTokens;
      const outputTokens = generated.usage.outputTokens;
      if (inputTokens === undefined || outputTokens === undefined) {
        usage.usageUnreported += 1;
        usage.spentUsd += worstUsd(row);
      } else {
        usage.inputTokens += inputTokens;
        usage.outputTokens += outputTokens;
        usage.spentUsd += (inputTokens * pricing.inputUsdPerMillionTokens +
          outputTokens * pricing.outputUsdPerMillionTokens) / 1_000_000;
      }
      usage.reasoningTokens += generated.usage.outputTokenDetails?.reasoningTokens ?? 0;
      if (generated.finishReason === "length") usage.truncated += 1;
      texts.set(row.messagesDigest, generated.text.slice(0, 20_000));
      await target.write(snapshot(false));
    }
  } finally {
    await target.write(snapshot(stop === null)).finally(() => target.close());
  }
  return {
    followupAnswers: { bundle: file.bundleId, evalDigest: file.evalDigest, model: model.id, kind,
      planned: pending.length, plannedWorstUsd: Math.round(plannedWorstUsd * 1e6) / 1e6,
      answeredMessages: texts.size, distinctMessages: distinct.size, answerRows: snapshot(false).answers.length,
      ...usage, spentUsd: Math.round(usage.spentUsd * 1e6) / 1e6, savedAnswers: resolve(save) },
    paidCalls: usage.calls,
    ...(stop ?? {}),
  };
}
