import "server-only";

import { createHash } from "node:crypto";
import { generateText, modelMessageSchema, stepCountIs, wrapLanguageModel, type LanguageModel, type LanguageModelUsage, type ModelMessage } from "ai";
import { z } from "zod";
import type { AiModel } from "./models";
import { createResearchPreviewExecution, ResearchPreviewBudgetExhaustedError, ResearchPreviewUsageUnknownError, usedResearchOutputTokens } from "./researchPreviewExecution";
import { researchPreviewInstructions, researchPreviewMessages } from "./researchPreviewPrompt";
import { createResearchEvidenceRegistry, researchEvidenceSourceSchema } from "./researchPreviewReport";
import { curateResearchPageEvidence, researchPageReadResultSchema } from "./researchPreviewPageEvidence";
import { safeResultUrl } from "./webSearchBackendAdapter";
import { getModelGenerationSettings } from "./modelGenerationCompatibility";
import { fitChatOutputToContextWindow } from "./chatContextWindow";

export const RESEARCH_PREVIEW_CHECKPOINT_MAX_BYTES = 512 * 1024;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const source = z.object({ url: z.string().max(2048), title: z.string().max(200).optional(), snippet: z.string().max(400).optional(), publishedAt: z.string().max(64).optional() }).strict();
const successfulResult = z.object({ status: z.literal("ok"), query: z.string().max(400).optional(), searchesRemaining: count.max(5), results: z.array(source.extend({ title: z.string().max(200) })).max(5), notice: z.string().max(2000).optional(), truncated: z.boolean().optional() }).strict();
const usageSchema = z.object({ inputTokens: count, outputTokens: count, cachedInputTokens: count, cacheWriteTokens: count, reasoningTokens: count }).strict();
export type ResearchStepUsage = z.infer<typeof usageSchema>;

export const researchPreviewCheckpointSchema = z.object({
  version: z.literal(1), modelId: z.string().min(1).max(100), apiModel: z.string().min(1).max(200),
  questionHash: z.string().regex(/^[a-f0-9]{64}$/), locale: z.string().min(2).max(35), currentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  totalOutputTokens: count.min(1).max(4096), inputTokenCeiling: count.min(1), pageReadingEnabled: z.boolean(), completedSteps: count.max(3),
  reasoning: z.enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh", "max"]),
  messages: z.array(modelMessageSchema).min(1).max(64), sources: z.array(researchEvidenceSourceSchema).max(25),
  search: z.object({ backend: z.literal("brave"), backendRequestCount: count.max(5), succeededRequestCount: count.max(5), refusedCallCount: count,
    executed: z.boolean(), sources: z.array(source).max(15), failureCode: z.string().max(100).optional(), maxQueries: z.literal(5) }).strict(),
  successfulCache: z.array(z.object({ key: z.string().max(1000), result: successfulResult }).strict()).max(5),
  pageReads: z.array(researchPageReadResultSchema).max(2), usage: usageSchema,
  stopReason: z.enum(["report_submitted", "invalid_report", "unknown_source", "missing_report", "budget_exhausted"]).nullable(),
}).strict().superRefine((value, context) => {
  const invalid = () => context.addIssue({ code: "custom", message: "Invalid Research checkpoint" });
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > RESEARCH_PREVIEW_CHECKPOINT_MAX_BYTES ||
      value.search.succeededRequestCount > value.search.backendRequestCount ||
      value.search.executed !== (value.search.succeededRequestCount > 0) ||
      value.successfulCache.length > value.search.succeededRequestCount ||
      value.usage.outputTokens > value.totalOutputTokens || value.usage.cachedInputTokens > value.usage.inputTokens ||
      (!value.pageReadingEnabled && value.pageReads.length > 0)) invalid();
  try { createResearchEvidenceRegistry(value.sources); } catch { invalid(); }
  const urls = new Set(value.sources.map(entry => entry.url));
  for (const entry of value.search.sources) if (!urls.has(entry.url) || safeResultUrl(entry.url) !== entry.url) invalid();
  const keys = new Set<string>();
  for (const entry of value.successfulCache) {
    if (keys.has(entry.key) || entry.result.results.some(result => !urls.has(result.url))) invalid();
    keys.add(entry.key);
  }
  const reads = new Set<string>();
  for (const entry of value.pageReads) {
    if (reads.has(entry.sourceId) || value.sources.find(source => source.sourceId === entry.sourceId)?.url !== entry.url) invalid();
    reads.add(entry.sourceId);
  }
  for (const entry of value.sources) {
    const read = value.pageReads.find(read => read.sourceId === entry.sourceId);
    if (JSON.stringify(entry.pageRead ?? null) !== JSON.stringify(read ? curateResearchPageEvidence(read) : null)) invalid();
  }
  if (value.messages.filter(message => message.role === "assistant").length !== value.completedSteps ||
      (value.completedSteps === 0 && Object.values(value.usage).some(value => value !== 0))) invalid();
  const calls = new Map<string, string>();
  for (const [index, message] of value.messages.entries()) {
    if (index === 0) { if (message.role !== "user" || typeof message.content !== "string") invalid(); continue; }
    if (message.role !== "assistant" && message.role !== "tool") { invalid(); continue; }
    if (typeof message.content === "string") { if (message.role !== "assistant") invalid(); continue; }
    for (const part of message.content) {
      if (part.type === "text" && message.role === "assistant") continue;
      if (part.type !== "tool-call" && part.type !== "tool-result") { invalid(); continue; }
      if (!["web_search", "read_research_sources", "submit_research_report"].includes(part.toolName)) invalid();
      if (part.type === "tool-call") { if (calls.has(part.toolCallId)) invalid(); calls.set(part.toolCallId, part.toolName); }
      else { if (calls.get(part.toolCallId) !== part.toolName) invalid(); calls.delete(part.toolCallId); }
    }
  }
  if (calls.size) invalid();
});
export type ResearchPreviewCheckpoint = z.infer<typeof researchPreviewCheckpointSchema>;

export function parseResearchPreviewCheckpoint(value: unknown): ResearchPreviewCheckpoint {
  if (Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") > RESEARCH_PREVIEW_CHECKPOINT_MAX_BYTES) throw new Error("Research checkpoint exceeds its size limit");
  return researchPreviewCheckpointSchema.parse(value);
}

function knownUsage(usage: LanguageModelUsage): ResearchStepUsage {
  if (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens! < 0 || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens! < 0) throw new ResearchPreviewUsageUnknownError();
  const optional = (value: number | undefined) => {
    if (value === undefined) return 0;
    if (!Number.isSafeInteger(value) || value < 0) throw new ResearchPreviewUsageUnknownError();
    return value;
  };
  return usageSchema.parse({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    cachedInputTokens: optional(usage.inputTokenDetails.cacheReadTokens), cacheWriteTokens: optional(usage.inputTokenDetails.cacheWriteTokens), reasoningTokens: optional(usage.outputTokenDetails.reasoningTokens) });
}

/** One provider dispatch, then a fully completed tool/evidence checkpoint. No retries or hidden continuation. */
export async function runResearchPreviewStep(input: {
  model: LanguageModel; modelConfig: AiModel; question: string; locale: string; currentDate: string;
  totalOutputTokens: number; inputTokenCeiling: number; pageReadingEnabled: boolean;
  checkpoint?: ResearchPreviewCheckpoint; signal: AbortSignal;
  onBeforeModelDispatch?: () => Promise<void>;
  onSearchOutcome?: Parameters<typeof createResearchPreviewExecution>[0]["onSearchOutcome"];
  pageReader?: Parameters<typeof createResearchPreviewExecution>[0]["pageReader"];
}) {
  if (typeof input.model === "string") throw new Error("Research requires an explicit provider model");
  if (!input.question.trim() || input.question.length > 4000) throw new Error("Invalid Research question");
  const identity = { version: 1 as const, modelId: input.modelConfig.id, apiModel: input.modelConfig.apiModel,
    questionHash: createHash("sha256").update(input.question).digest("hex"), locale: input.locale, currentDate: input.currentDate,
    totalOutputTokens: input.totalOutputTokens, inputTokenCeiling: input.inputTokenCeiling, pageReadingEnabled: input.pageReadingEnabled,
    reasoning: input.modelConfig.reasoning ?? "provider-default" as const };
  const checkpoint = input.checkpoint ? parseResearchPreviewCheckpoint(input.checkpoint) : parseResearchPreviewCheckpoint({ ...identity,
    completedSteps: 0, messages: researchPreviewMessages(input.question), sources: [], search: { backend: "brave", backendRequestCount: 0, succeededRequestCount: 0, refusedCallCount: 0, executed: false, sources: [], maxQueries: 5 },
    successfulCache: [], pageReads: [], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, stopReason: null });
  for (const key of Object.keys(identity) as Array<keyof typeof identity>) if (checkpoint[key] !== identity[key]) throw new Error("Research checkpoint identity changed");
  if (checkpoint.messages[0]?.content !== input.question || checkpoint.stopReason || checkpoint.completedSteps >= 3 || checkpoint.usage.outputTokens >= input.totalOutputTokens) throw new ResearchPreviewBudgetExhaustedError();
  const execution = createResearchPreviewExecution({ backend: "brave", provider: input.modelConfig.provider, totalOutputTokens: input.totalOutputTokens, locale: input.locale, signal: input.signal,
    pageReadingEnabled: input.pageReadingEnabled, initialSources: checkpoint.sources, initialSearchSnapshot: checkpoint.search,
    initialSuccessfulCache: checkpoint.successfulCache, initialPageReads: checkpoint.pageReads, previousOutputTokens: checkpoint.usage.outputTokens,
    stepNumberOffset: checkpoint.completedSteps, onSearchOutcome: input.onSearchOutcome, pageReader: input.pageReader });
  const model = wrapLanguageModel({ model: input.model, middleware: { specificationVersion: "v4", wrapGenerate: async ({ doGenerate, params }) => {
    // Provider-normalized protocol, schemas and quoted evidence are all covered by the frozen reservation.
    const protocolBytes = Buffer.byteLength(JSON.stringify(params), "utf8");
    if (protocolBytes > input.inputTokenCeiling + checkpoint.usage.outputTokens) throw new Error("Research input exceeds its reserved ceiling");
    const remainingOutput = input.totalOutputTokens - checkpoint.usage.outputTokens;
    const context = fitChatOutputToContextWindow({ contextWindowTokens: input.modelConfig.contextWindowTokens,
      reservedInputTokens: protocolBytes, requestOutputCapTokens: remainingOutput });
    if (context.kind === "exceeded" || context.outputTokens < remainingOutput) throw new ResearchPreviewBudgetExhaustedError();
    input.signal.throwIfAborted();
    await input.onBeforeModelDispatch?.();
    input.signal.throwIfAborted();
    return doGenerate();
  } } });
  const result = await generateText({ ...getModelGenerationSettings(input.modelConfig), reasoning: identity.reasoning, model, system: researchPreviewInstructions(input), messages: checkpoint.messages as ModelMessage[],
    tools: execution.tools, prepareStep: execution.prepareStep, stopWhen: stepCountIs(1), maxRetries: 0,
    maxOutputTokens: input.totalOutputTokens - checkpoint.usage.outputTokens, abortSignal: input.signal });
  usedResearchOutputTokens(result.steps, input.modelConfig.provider); // Aggregate SDK usage can hide a missing per-step counter.
  const usage = knownUsage(result.steps[0]!.usage);
  if (usage.inputTokens > input.inputTokenCeiling + checkpoint.usage.outputTokens || checkpoint.usage.outputTokens + usage.outputTokens > input.totalOutputTokens) throw new ResearchPreviewUsageUnknownError();
  const aggregateUsage = Object.fromEntries(Object.keys(checkpoint.usage).map(key => [key, checkpoint.usage[key as keyof ResearchStepUsage] + usage[key as keyof ResearchStepUsage]]));
  execution.observeCompletedSteps(result.steps);
  const report = execution.finalReport();
  const completedSteps = checkpoint.completedSteps + 1;
  const failedTerminal = result.steps.some(step => step.content.some(part => part.type === "tool-error" && part.toolName === "submit_research_report"));
  const finished = report !== null || failedTerminal || completedSteps === 3 || Number(aggregateUsage.outputTokens) >= input.totalOutputTokens;
  const responseMessages = result.response.messages.map(message => message.role === "assistant" && Array.isArray(message.content)
    ? { ...message, content: message.content.filter(part => part.type !== "reasoning") } : message);
  const next = parseResearchPreviewCheckpoint({ ...identity, completedSteps, messages: [...checkpoint.messages, ...responseMessages], sources: execution.registry.snapshot(),
    search: execution.session.snapshot(), successfulCache: await execution.successfulCacheSnapshot?.() ?? [], pageReads: await execution.pageReadsSnapshot(), usage: aggregateUsage,
    stopReason: finished ? report ? "report_submitted" : Number(aggregateUsage.outputTokens) >= input.totalOutputTokens ? "budget_exhausted" : execution.stopReason() : null });
  return { checkpoint: next, report, usage, finished };
}
