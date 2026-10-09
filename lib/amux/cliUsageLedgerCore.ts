/** Content-free AMUX CLI telemetry. A selected model is never treated as an
 * attestation of the model actually served by a CLI. */
import { createHash } from "node:crypto";
import { z } from "zod";

import type { AmuxCliUsageObservation } from "./cliUsageObservationCore";

const id = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const model = z.string().regex(/^[A-Za-z0-9._/\[\]-]{1,160}$/);
const count = z.number().int().safe().nonnegative();
const counts = z.object({
  inputTokens: count,
  outputTokens: count,
  cacheReadInputTokens: count,
  cacheCreationInputTokens: count.nullable(),
  reasoningOutputTokens: count.nullable(),
}).strict();

export const amuxCliUsageReceiptSchema = z.object({
  version: z.literal(1),
  invocationId: id,
  binding: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("task_attempt"), attemptId: id }).strict(),
    z.object({ kind: z.literal("idea_analysis"), holdId: id }).strict(),
  ]),
  worker: id,
  cli: z.enum(["codex", "claude"]),
  provider: z.enum(["openai", "anthropic"]),
  selectedModelId: model,
  actualModelId: model.nullable(),
  cliVersion: z.string().regex(/^[A-Za-z0-9._+-]{1,80}$/).nullable(),
  authentication: z.enum(["subscription", "api_key", "unknown"]),
  startedAt: z.string().datetime({ offset: false }),
  endedAt: z.string().datetime({ offset: false }),
  status: z.enum(["succeeded", "failed", "interrupted", "outcome_unknown"]),
  completeness: z.enum(["reported_complete", "reported_partial", "unknown"]),
  source: z.enum(["codex_jsonl", "claude_result", "unreported"]),
  observed: counts.nullable(),
  inputTokensIncludeCacheRead: z.boolean(),
  inputTokensIncludeCacheWrite: z.boolean().nullable(),
  reasoningOutputIncludedInOutput: z.boolean().nullable(),
  completedTurns: count.max(128),
}).strict().superRefine((value, context) => {
  if (value.cli === "codex" && value.provider !== "openai" ||
      value.cli === "claude" && value.provider !== "anthropic" ||
      Date.parse(value.endedAt) < Date.parse(value.startedAt) ||
      (value.completeness === "unknown") !== (value.observed === null) ||
      (value.source === "unreported") !== (value.observed === null) ||
      (value.source === "codex_jsonl" && value.cli !== "codex") ||
      (value.source === "claude_result" && value.cli !== "claude") ||
      (value.cli === "codex" &&
        (!value.inputTokensIncludeCacheRead ||
          value.reasoningOutputIncludedInOutput !== true)) ||
      (value.cli === "claude" &&
        (value.inputTokensIncludeCacheRead ||
          value.inputTokensIncludeCacheWrite !== false)) ||
      (value.completeness === "reported_complete" && value.completedTurns === 0) ||
      (value.actualModelId !== null && value.actualModelId.split("/").some(
        (part) => part === "" || part === "." || part === ".."))) {
    context.addIssue({ code: "custom", message: "inconsistent_cli_usage" });
  }
  if (value.observed && (value.observed.cacheReadInputTokens >
      value.observed.inputTokens && value.inputTokensIncludeCacheRead ||
      value.observed.reasoningOutputTokens !== null &&
      value.observed.reasoningOutputTokens > value.observed.outputTokens)) {
    context.addIssue({ code: "custom", message: "invalid_token_partition" });
  }
  if (value.observed && ![
    value.observed.inputTokens, value.observed.outputTokens,
    value.observed.cacheReadInputTokens,
    value.observed.cacheCreationInputTokens ?? 0,
  ].some((tokens) => tokens > 0)) {
    context.addIssue({ code: "custom", message: "zero_is_not_observed_usage" });
  }
});

export type AmuxCliUsageReceipt = z.infer<typeof amuxCliUsageReceiptSchema>;

/** v22 accepts no silent CLI model fallback. A different served model has a
 * different approved route and price and therefore cannot settle this Task. */
export function v22ReceiptModelMatchesAssignment(receipt: AmuxCliUsageReceipt): boolean {
  return receipt.binding.kind !== "task_attempt" ||
    receipt.actualModelId === null ||
    receipt.actualModelId === receipt.selectedModelId;
}

export function amuxCliUsageReceiptDigest(receipt: AmuxCliUsageReceipt): string {
  return createHash("sha256").update("amux-cli-usage-v1\n", "utf8")
    .update(JSON.stringify(receipt), "utf8").digest("hex");
}

/** The CLI parser may lack a served-model attestation. Preserve that absence. */
export function makeAmuxCliUsageReceipt(input: Omit<AmuxCliUsageReceipt,
  "version" | "cli" | "provider" | "actualModelId" | "completeness" |
  "observed" | "inputTokensIncludeCacheRead" |
  "inputTokensIncludeCacheWrite" | "reasoningOutputIncludedInOutput" |
  "completedTurns" | "source"> & {
    observation: AmuxCliUsageObservation;
  }): AmuxCliUsageReceipt {
  const { observation, ...rest } = input;
  const actualModelId = observation.models.length === 1
    ? observation.models[0].modelId : observation.models.length > 1
      ? "multi_model" : null;
  return amuxCliUsageReceiptSchema.parse({ ...rest, version: 1,
    cli: observation.cli,
    provider: observation.cli === "codex" ? "openai" : "anthropic",
    actualModelId,
    completeness: observation.completeness,
    observed: observation.observed,
    inputTokensIncludeCacheRead: observation.inputTokensIncludeCacheRead,
    inputTokensIncludeCacheWrite: observation.inputTokensIncludeCacheWrite,
    reasoningOutputIncludedInOutput: observation.reasoningOutputIncludedInOutput,
    completedTurns: observation.completedTurns,
    source: observation.observed === null ? "unreported" :
      observation.cli === "codex" ? "codex_jsonl" : "claude_result",
  });
}

export type AmuxCliApiPrice = {
  provider: "openai" | "anthropic";
  modelId: string;
  version: string;
  uncachedInputMicroUsdPerMillion: number;
  cacheReadMicroUsdPerMillion: number;
  cacheWriteMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
  reasoningOutputMicroUsdPerMillion: number | null;
};

/** This is a future API-key conversion estimate, never subscription billing. */
export function estimateAmuxCliApiCost(receipt: AmuxCliUsageReceipt,
  price: AmuxCliApiPrice | null): bigint | null {
  const usage = receipt.observed;
  if (!usage || !price || receipt.completeness !== "reported_complete" ||
      receipt.actualModelId !== price.modelId ||
      receipt.actualModelId === "multi_model" ||
      receipt.provider !== price.provider ||
      !/^[A-Za-z0-9._:-]{1,160}$/.test(price.version) ||
      ![price.uncachedInputMicroUsdPerMillion,
        price.cacheReadMicroUsdPerMillion,
        price.cacheWriteMicroUsdPerMillion,
        price.outputMicroUsdPerMillion].every((v) =>
        Number.isSafeInteger(v) && v >= 0) ||
      (price.reasoningOutputMicroUsdPerMillion !== null &&
       (!Number.isSafeInteger(price.reasoningOutputMicroUsdPerMillion) ||
        price.reasoningOutputMicroUsdPerMillion < 0))) return null;
  if (usage.cacheCreationInputTokens === null ||
      receipt.inputTokensIncludeCacheWrite === null) return null;
  const uncached = usage.inputTokens -
    (receipt.inputTokensIncludeCacheRead ? usage.cacheReadInputTokens : 0) -
    (receipt.inputTokensIncludeCacheWrite ? usage.cacheCreationInputTokens : 0);
  if (uncached < 0) return null;
  const reasoning = usage.reasoningOutputTokens;
  if (price.reasoningOutputMicroUsdPerMillion !== null &&
      (reasoning === null || receipt.reasoningOutputIncludedInOutput === null)) return null;
  const output = usage.outputTokens - (price.reasoningOutputMicroUsdPerMillion !== null &&
    receipt.reasoningOutputIncludedInOutput ? reasoning ?? 0 : 0);
  if (output < 0) return null;
  const parts: Array<[number, number]> = [
    [uncached, price.uncachedInputMicroUsdPerMillion],
    [usage.cacheReadInputTokens, price.cacheReadMicroUsdPerMillion],
    [usage.cacheCreationInputTokens, price.cacheWriteMicroUsdPerMillion],
    [output, price.outputMicroUsdPerMillion],
  ];
  if (price.reasoningOutputMicroUsdPerMillion !== null && reasoning !== null)
    parts.push([reasoning, price.reasoningOutputMicroUsdPerMillion]);
  return parts.reduce((total, [tokens, rate]) => total +
    (BigInt(tokens) * BigInt(rate) + BigInt(999_999)) / BigInt(1_000_000), BigInt(0));
}
