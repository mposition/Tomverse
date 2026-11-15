import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { AVAILABLE_MODELS, type AiModel } from "./models";
import { resolveModelPricing } from "./modelPricing";
import { createResearchPreviewBudget } from "./researchPreviewBudget";
import { researchPreviewInputEstimate } from "./researchPreviewPrompt";
import { getChatBudgetReservedCostMicroUsd } from "./chatSecurity";
import { getWebSearchCapability } from "./webSearchCapability";
import { reserveTurnSearchCost } from "./webSearchNativeCostReservation";
import { calculateProviderUsageCost } from "./providerUsageCost";
import { readResponseToBuffer } from "./boundedBuffer";

export const RESEARCH_EVALUATION_MAX_MICRO_USD = 10_000_000;
export const RESEARCH_EVALUATION_MODEL_IDS = ["gemini-4-argon", "gpt-6-luna", "gemini-3-1-pro", "command-a-plus"] as const;
export type ResearchEvaluationModelId = (typeof RESEARCH_EVALUATION_MODEL_IDS)[number];
export const RESEARCH_EVALUATION_DEFAULT_MODELS = ["gemini-4-argon", "gpt-6-luna"] as const;
export const RESEARCH_EVALUATION_CREDENTIAL_SCOPE = "development-selected-research-providers-and-brave";
export const RESEARCH_EVALUATION_RERANK_MODEL = "rerank-v5.0-fast";
export const RESEARCH_EVALUATION_RERANK_MAX_TOKENS = 25 * 32_768;
const RERANK_INPUT_USD_PER_MILLION = 0.02;

export const RESEARCH_EVALUATION_CASES = [
  { id: "official-runtime-support", question: "Compare the current supported Node.js releases using official Node.js sources. Distinguish Active LTS, Maintenance LTS and Current, and state the date of the evidence. Identify any uncertainty.", locale: "en" },
  { id: "official-web-accessibility", question: "WCAG 2.2의 키보드 접근성과 포커스 가시성 요구사항을 W3C 공식 자료로 조사하고, 필수 기준과 권고를 구분해 주세요. 확인할 수 없는 내용은 한계로 밝혀 주세요.", locale: "ko" },
] as const;

export const researchEvaluationDigest = (value: unknown): string => {
  const canonical = (input: unknown): string => input === null || typeof input !== "object" ? JSON.stringify(input) :
    Array.isArray(input) ? `[${input.map(canonical).join(",")}]` : `{${Object.entries(input).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(",")}}`;
  return createHash("sha256").update(canonical(value)).digest("hex");
};

/** Development-only clones: never write the runtime catalogue or production prices. */
export function resolveResearchEvaluationModel(id: string): AiModel {
  if (!RESEARCH_EVALUATION_MODEL_IDS.includes(id as ResearchEvaluationModelId)) throw new Error("Unknown Research evaluation model");
  const pro: AiModel = AVAILABLE_MODELS.find(model => model.id === "gemini-3-1-pro")!;
  if (id === "gemini-4-argon") return { ...pro, id, name: "Gemini 4 Argon", apiModel: "gemini-4-argon",
    reasoning: "low", webSearchOverride: "app-managed", maxOutputTokens: 4096, reservationOutputTokens: 4096,
    inputUsdPerMillionTokens: 4, outputUsdPerMillionTokens: 20, cachedInputPriceMultiplier: 1 };
  const model: AiModel | undefined = AVAILABLE_MODELS.find(model => model.id === id);
  if (!model) throw new Error("Research evaluation model profile is unavailable");
  const pricing = resolveModelPricing(model);
  if (id === "command-a-plus" && (String(model.provider) !== "cohere" || model.apiModel !== "command-a-plus-05-2026" ||
      pricing.inputUsdPerMillionTokens !== 0 || pricing.outputUsdPerMillionTokens !== 0 ||
      pricing.pricingVersion !== "cohere-command-a-plus-hosted-free-2026-11-15")) throw new Error("Command A+ requires its verified exact hosted free profile");
  return { ...model, reasoning: id === "gpt-6-luna" ? "low" : id === "command-a-plus" ? "none" : model.reasoning,
    webSearchOverride: "app-managed" };
}

export function buildResearchEvaluationManifest(input: {
  sourceDigest: string; currentDate: string; expiresAt: string; maxTotalMicroUsd: number;
  caseIds?: readonly string[]; modelIds?: readonly string[]; rerank?: boolean;
}) {
  const caseIds = input.caseIds ?? [RESEARCH_EVALUATION_CASES[0].id];
  const modelIds = input.modelIds ?? RESEARCH_EVALUATION_DEFAULT_MODELS;
  if (!/^[a-f0-9]{64}$/.test(input.sourceDigest) || !/^\d{4}-\d{2}-\d{2}$/.test(input.currentDate) ||
      !Number.isSafeInteger(input.maxTotalMicroUsd) || input.maxTotalMicroUsd < 1 || input.maxTotalMicroUsd > RESEARCH_EVALUATION_MAX_MICRO_USD ||
      !Number.isFinite(Date.parse(input.expiresAt)) || caseIds.length < 1 || modelIds.length < 1 ||
      caseIds.length * modelIds.length > 2 || new Set(caseIds).size !== caseIds.length || new Set(modelIds).size !== modelIds.length) {
    throw new Error("Evaluation is limited to two model/brief pairs, six model calls and US$10");
  }
  const models = modelIds.map(id => {
    const model = resolveResearchEvaluationModel(id);
    return { id: model.id, apiModel: model.apiModel, provider: model.provider, reasoning: model.reasoning ?? "provider-default",
      contextWindowTokens: model.contextWindowTokens ?? 1_048_576 };
  });
  const cases = models.flatMap(profile => caseIds.map(id => {
    const brief = RESEARCH_EVALUATION_CASES.find(brief => brief.id === id);
    if (!brief) throw new Error("Unknown Research evaluation case");
    const model = resolveResearchEvaluationModel(profile.id);
    const reservation = reserveTurnSearchCost({ model, capability: getWebSearchCapability(model), nativeSearchEnabled: false, appManagedSearchEnabled: true });
    if (!reservation.ok || !reservation.searchBackend) throw new Error("Research evaluation search is not priced");
    const pipeline = createResearchPreviewBudget({ accessKind: "user", model,
      input: researchPreviewInputEstimate({ ...brief, currentDate: input.currentDate, pageReadingEnabled: true }),
      webSearchSurchargeCredits: 0, searchReservation: reservation, pageReadingEnabled: true });
    const requestInputCeiling = Math.min(pipeline.contextInputTokens ?? pipeline.inputTokens, profile.contextWindowTokens - pipeline.maxOutputTokens);
    if (requestInputCeiling < 1) throw new Error("Evaluation model has no bounded input capacity");
    const budget = { ...pipeline, contextInputTokens: requestInputCeiling,
      inputTokens: Math.min(pipeline.inputTokens, 3 * requestInputCeiling + 2 * pipeline.maxOutputTokens),
      ...(profile.id === "gemini-4-argon" ? { pricingVersion: "development-gemini-4-argon-standard-4-20-2026-11-15", costSource: "development_explicit_verified_rate" } : {}) };
    const pricingBasis = profile.id === "gemini-4-argon" ? "Development-only standard US$4 input / US$20 output per million; no temporary discount or assumed cache discount" :
      profile.id === "command-a-plus" ? "Exact command-a-plus-05-2026 hosted api.cohere.com/v2 profile: verified free until rate limits; excludes Model Vault and other models" :
      "Existing frozen catalogue rate including the applicable context tier";
    return { ...brief, runKey: `${profile.id}:${brief.id}`, modelId: profile.id, apiModel: profile.apiModel, provider: profile.provider,
      reasoning: profile.reasoning, pricingBasis, budget, reservedMicroUsd: getChatBudgetReservedCostMicroUsd(budget) + budget.searchBackend!.reservedCostMicroUsd };
  }));
  const rerank = { enabled: input.rerank === true, model: RESEARCH_EVALUATION_RERANK_MODEL,
    maxCalls: input.rerank ? 1 : 0, maxDocuments: 25, maxSnippetCharacters: 400,
    maxInputTokens: RESEARCH_EVALUATION_RERANK_MAX_TOKENS, inputUsdPerMillionTokens: RERANK_INPUT_USD_PER_MILLION,
    pricingVersion: "cohere-rerank-v5-fast-0.02-2026-11-15", pricingSource: "https://cohere.com/blog/rerank-5",
    reservedMicroUsd: input.rerank ? Math.ceil(RESEARCH_EVALUATION_RERANK_MAX_TOKENS * RERANK_INPUT_USD_PER_MILLION) : 0,
    scope: "One side experiment on captured public search snippets; no HTML, new searches, report rewrite or model judge" };
  const providers = [...new Set(["brave", ...models.map(model => model.provider), ...(input.rerank ? ["cohere"] : [])])].sort();
  const body = { version: 2, purpose: "research-preview-development-evaluation", sourceDigest: input.sourceDigest,
    models, currentDate: input.currentDate, expiresAt: input.expiresAt, credentialScope: RESEARCH_EVALUATION_CREDENTIAL_SCOPE, providers,
    cases, rerank, maxTotalMicroUsd: input.maxTotalMicroUsd, hardCeilingMicroUsd: RESEARCH_EVALUATION_MAX_MICRO_USD,
    totalReservedMicroUsd: cases.reduce((sum, entry) => sum + entry.reservedMicroUsd, 0) + rerank.reservedMicroUsd,
    maxModelCalls: cases.length * 3, maxSearchAttempts: cases.length * 5, maxPageReads: cases.length * 2,
    maxRerankCalls: rerank.maxCalls, timeoutMsPerCase: 600_000,
    qualityReview: ["Read each cited source and manually classify claim support", "Check complete/partial/insufficient-evidence honesty and page truncation", "Record latency, usage and frozen-rate total cost; no extra model judge"],
  };
  return { ...body, manifestDigest: researchEvaluationDigest(body) };
}
export type ResearchEvaluationManifest = ReturnType<typeof buildResearchEvaluationManifest>;

const approvalSchema = z.object({ version: z.literal(2), manifestDigest: z.string().regex(/^[a-f0-9]{64}$/), approvedBy: z.string().trim().min(1).max(100),
  approvedAt: z.string().datetime({ offset: true }), credentialScope: z.literal(RESEARCH_EVALUATION_CREDENTIAL_SCOPE), maxTotalMicroUsd: z.number().int().positive().max(RESEARCH_EVALUATION_MAX_MICRO_USD) }).strict();

export function validateResearchEvaluationApproval(value: unknown, manifest: ResearchEvaluationManifest, now = Date.now()) {
  const approval = approvalSchema.parse(value);
  const { manifestDigest, ...body } = manifest;
  if (researchEvaluationDigest(body) !== manifestDigest || approval.manifestDigest !== manifestDigest || approval.maxTotalMicroUsd !== manifest.maxTotalMicroUsd ||
      manifest.totalReservedMicroUsd > approval.maxTotalMicroUsd || Date.parse(manifest.expiresAt) <= now || Date.parse(approval.approvedAt) > now ||
      Date.parse(approval.approvedAt) >= Date.parse(manifest.expiresAt)) throw new Error("Research evaluation approval does not cover this run");
  return approval;
}

export function researchEvaluationMeasuredCost(usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteTokens: number }, entry: ResearchEvaluationManifest["cases"][number], searchCount: number) {
  if (![usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.cacheWriteTokens, searchCount].every(value => Number.isSafeInteger(value) && value >= 0) ||
      searchCount > 5 || usage.cachedInputTokens > usage.inputTokens) return null;
  const cost = calculateProviderUsageCost({ ...entry.budget, ...usage, cacheWriteInputTokens: usage.cacheWriteTokens });
  if (cost.unpricedCacheWriteTokens) return null;
  return cost.totalCostMicroUsd + searchCount * entry.budget.searchBackend!.costPerQueryMicroUsd;
}

/** One fixed-endpoint side experiment. Only captured source snippets leave. */
export async function rerankResearchEvaluationSnippets(input: {
  key: string; query: string; sources: readonly { sourceId: string; url: string; snippet?: string }[];
  signal?: AbortSignal; onBeforeDispatch?: () => Promise<void>;
}, transport: typeof fetch = fetch) {
  if (!input.key.trim() || !input.query.trim() || input.query.length > 4000) throw new Error("Invalid bounded rerank input");
  const documents = input.sources.filter(source => source.snippet?.trim()).map(source => ({ sourceId: source.sourceId, url: source.url, snippet: source.snippet! }));
  if (!documents.length || documents.length > 25 || new Set(documents.map(source => source.sourceId)).size !== documents.length ||
      documents.some(source => !/^R(?:[1-9]|1\d|2[0-5])$/.test(source.sourceId) || source.snippet.length > 400 || !/^https?:\/\//.test(source.url))) throw new Error("Invalid captured rerank sources");
  const body = JSON.stringify({ model: RESEARCH_EVALUATION_RERANK_MODEL, query: input.query, documents: documents.map(source => source.snippet),
    top_n: Math.min(3, documents.length), return_documents: false, max_tokens_per_doc: 2048 });
  if (Buffer.byteLength(body) > 96 * 1024) throw new Error("Rerank input exceeds its approved ceiling");
  const signal = AbortSignal.any([AbortSignal.timeout(25_000), ...(input.signal ? [input.signal] : [])]);
  signal.throwIfAborted(); await input.onBeforeDispatch?.(); signal.throwIfAborted();
  const response = await transport("https://api.cohere.com/v2/rerank", { method: "POST", redirect: "error", cache: "no-store", signal,
    headers: { Authorization: `Bearer ${input.key}`, "Content-Type": "application/json" }, body });
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error("Rerank provider refused the request"); }
  const data = JSON.parse((await readResponseToBuffer(response, 64 * 1024, signal)).toString("utf8")) as {
    results?: Array<{ index?: number; relevance_score?: number }>; meta?: { billed_units?: { input_tokens?: number } };
  };
  const tokens = data.meta?.billed_units?.input_tokens;
  if (!Number.isSafeInteger(tokens) || tokens! < 0 || tokens! > RESEARCH_EVALUATION_RERANK_MAX_TOKENS) throw new Error("Rerank usage is unknown or exceeds its authorization");
  if (!Array.isArray(data.results) || data.results.length !== Math.min(3, documents.length) ||
      new Set(data.results.map(result => result.index)).size !== data.results.length ||
      data.results.some(result => !Number.isInteger(result.index) || result.index! < 0 || result.index! >= documents.length ||
        typeof result.relevance_score !== "number" || !Number.isFinite(result.relevance_score) || result.relevance_score < 0 || result.relevance_score > 1)) throw new Error("Invalid source-bound rerank output");
  return { model: RESEARCH_EVALUATION_RERANK_MODEL, inputTokens: tokens!, measuredCostMicroUsd: Math.ceil(tokens! * RERANK_INPUT_USD_PER_MILLION),
    ranking: data.results.map(result => ({ sourceId: documents[result.index!].sourceId, url: documents[result.index!].url, relevanceScore: result.relevance_score! })) };
}
