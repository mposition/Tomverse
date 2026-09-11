/** Development-only contracts. No provider, filesystem, credentials or product-account admission. */
import { getModelGenerationSettings } from "./modelGenerationCompatibility";
import { getModelPricingProfile, resolveModelPricing, type ModelPriceTier } from "./modelPricing";
import type { AiModel } from "./models";
import { benchmarkDigest, canonicalBenchmarkJson, isBenchmarkInstant, strictBenchmarkObject } from "./routerDevelopmentBenchmark";
import type { DevelopmentPlan, DevelopmentSource } from "./routerDevelopmentBenchmarkPlan";

export const COLLECTION_VERSION = "router-development-collector-v1.1";
export const COLLECTION_LIMITS = { answerStorageBytes: 1_048_576, journalBytes: 512 * 1_048_576, eventBytes: 7 * 1_048_576 } as const;
/** Exact body parsers implemented by the development adapter, not catalogue or account admission. */
export const COLLECTION_SUPPORTED_PROVIDERS = ["openai", "deepseek", "xai", "mistral", "moonshot", "anthropic", "minimax", "google"] as const;
export const isCollectionProviderSupported = (provider: string): boolean => (COLLECTION_SUPPORTED_PROVIDERS as readonly string[]).includes(provider);
export const COLLECTION_ASSUMPTIONS = [
  "operator-funded-development-only; not product-account execution",
  "conditional catalogue context input bound; not verified provider tokenization",
  "direct configured standard catalogue rates; actual processing and invoice unknown",
  "no tools/search/additional paid steps; product output cap assumed to include reasoning",
  "unpriced or unobserved cache writes and additional charges leave cost unknown",
  "runtime registry/health/access and shared product provider budgets are not verified or applied",
  "no network ingress hard byte or memory cap; storage limits apply after SDK reception",
  "all dispatched reservations remain held; no automatic retries or fallback",
  "local git-common-dir journal is not a central ledger against deletion or separate clones",
] as const;
export type CollectionLimits = {
  maxTotalMicroUsd: number; maxRequestMicroUsd: number; maxCalls: number;
  requestTimeoutMs: number; runTimeoutMs: number; expiresAt: string;
};
export function collectionFail(code: string): never { throw new Error(`collector_${code}`); }
export function collectionInteger(value: unknown, code: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) collectionFail(code);
  return value as number;
}
export function collectionId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) collectionFail("approval_id");
  return value as string;
}
export const collectionHash = (value: unknown) => benchmarkDigest(canonicalBenchmarkJson(value));
export function validateCollectionLimits(value: unknown): CollectionLimits {
  const obj = strictBenchmarkObject(value, ["maxTotalMicroUsd", "maxRequestMicroUsd", "maxCalls", "requestTimeoutMs", "runTimeoutMs", "expiresAt"], "collection_limits");
  for (const key of ["maxTotalMicroUsd", "maxRequestMicroUsd", "maxCalls", "requestTimeoutMs", "runTimeoutMs"]) collectionInteger(obj[key], `limit_${key}`, 1);
  if ((obj.maxCalls as number) > 1008 || (obj.requestTimeoutMs as number) > 3_600_000 || (obj.runTimeoutMs as number) > 86_400_000 || (obj.maxRequestMicroUsd as number) > (obj.maxTotalMicroUsd as number) || !isBenchmarkInstant(obj.expiresAt)) collectionFail("limits_range");
  return value as CollectionLimits;
}

/** MTok USD * tokens is microUSD. Decimal arithmetic avoids downward float rounding. */
export function ceilTokenMicroUsd(tokens: number, rate: number): number {
  collectionInteger(tokens, "token_count");
  if (!Number.isFinite(rate) || rate < 0) collectionFail("rate");
  const [mantissa, exponent = "0"] = String(rate).toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const power = Number(exponent) - fraction.length;
  const numerator = BigInt(whole + fraction) * BigInt(tokens) * (power >= 0 ? BigInt(10) ** BigInt(power) : BigInt(1));
  const denominator = power < 0 ? BigInt(10) ** BigInt(-power) : BigInt(1);
  const result = Number((numerator + denominator - BigInt(1)) / denominator);
  return collectionInteger(result, "cost_overflow");
}
export function sumCollectionMoney(values: readonly number[]): number {
  return collectionInteger(Number(values.reduce((sum, value) => sum + BigInt(collectionInteger(value, "money")), BigInt(0))), "cost_overflow");
}
export function reserveCollectionCost(contextTokens: number, outputTokens: number, tiers: readonly ModelPriceTier[]) {
  collectionInteger(contextTokens, "context_unknown", 1);
  collectionInteger(outputTokens, "output_cap", 1);
  if (!tiers.length) collectionFail("price_tiers_missing");
  for (const [index, tier] of tiers.entries()) {
    if (tier.maxPromptTokens === null ? index !== tiers.length - 1 : !Number.isSafeInteger(tier.maxPromptTokens) || tier.maxPromptTokens < 0 || index > 0 && (tiers[index - 1].maxPromptTokens === null || tier.maxPromptTokens <= tiers[index - 1].maxPromptTokens!)) collectionFail("price_tier_boundary");
    for (const rate of [tier.inputUsdPerMillionTokens, tier.outputUsdPerMillionTokens, tier.cachedInputPriceMultiplier, ...(tier.cacheWriteUsdPerMillionTokens === undefined ? [] : [tier.cacheWriteUsdPerMillionTokens])]) if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) collectionFail("rate");
  }
  const maxInputRate = Math.max(...tiers.flatMap((tier) => [tier.inputUsdPerMillionTokens, tier.inputUsdPerMillionTokens * tier.cachedInputPriceMultiplier, ...(tier.cacheWriteUsdPerMillionTokens === undefined ? [] : [tier.cacheWriteUsdPerMillionTokens])]));
  const maxOutputRate = Math.max(...tiers.map((tier) => tier.outputUsdPerMillionTokens));
  return { contextInputBoundAssumption: contextTokens, outputCapTokens: outputTokens, maxInputRate, maxOutputRate,
    // Settlement rounds three input partitions separately; their extra ceil is at most two.
    partitionRoundingAllowanceMicroUsd: 2,
    reservedMicroUsd: sumCollectionMoney([ceilTokenMicroUsd(contextTokens, maxInputRate), ceilTokenMicroUsd(outputTokens, maxOutputRate), 2]) };
}
export function collectionPricing(model: AiModel, at: number) {
  const resolved = resolveModelPricing(model, { at });
  const profile = getModelPricingProfile(model.id);
  if (!profile || resolved.isFallbackPricing || resolved.apiModelId !== model.apiModel || resolved.routing !== "direct_provider_api" || resolved.processingTier !== "standard" || resolved.reasoningTokenBilling !== "billed_as_output") collectionFail("pricing_unsupported");
  const revision = profile.priceSchedule?.find((candidate) => candidate.pricingVersion === resolved.pricingVersion);
  const tiers = revision?.tiers ?? profile.tiers;
  return { pricingVersion: resolved.pricingVersion, priceSource: resolved.priceSource, effectiveDate: resolved.effectiveDate,
    costSource: resolved.costSource, routing: resolved.routing, processingTier: resolved.processingTier,
    reasoningTokenBilling: resolved.reasoningTokenBilling,
    tiers: tiers.map((tier) => ({ ...tier, cacheWriteUsdPerMillionTokens: tier.cacheWriteUsdPerMillionTokens ?? null })) };
}
/** Acquisition needs these frozen matrix fields; the versioned caller validates the whole plan. */
export type CollectionPlan = Pick<DevelopmentPlan, "createdAt" | "source" | "rows" | "corpusDigest" | "planDigest">;
export function buildCollectionManifest<Plan extends CollectionPlan = DevelopmentPlan>(input: {
  plan: Plan; models: readonly AiModel[]; collectorSource: DevelopmentSource;
  selectedRowIds: readonly string[]; limits: CollectionLimits;
}) {
  const limits = validateCollectionLimits(input.limits);
  if (!Array.isArray(input.selectedRowIds) || !input.selectedRowIds.length || new Set(input.selectedRowIds).size !== input.selectedRowIds.length || input.selectedRowIds.length > 1008) collectionFail("selected_rows");
  if (Date.parse(limits.expiresAt) <= Date.parse(input.plan.createdAt)) collectionFail("expiry");
  const selectedRowIds = [...input.selectedRowIds].sort();
  const calls = selectedRowIds.map((rowId) => {
    const row = input.plan.rows.find((candidate) => candidate.rowId === rowId);
    if (!row?.benchmarkEligibility.eligible || !row.callConfig.proposedMaxOutputTokens) collectionFail("row_refused_or_unknown");
    const model = input.models.find((candidate) => candidate.id === row!.modelId);
    if (!model || model.apiModel !== row!.apiModel || model.provider !== row!.provider) collectionFail("model_identity");
    if (!isCollectionProviderSupported(model!.provider)) collectionFail("provider_family_unsupported");
    const pricing = collectionPricing(model!, Date.parse(input.plan.createdAt));
    const reserve = reserveCollectionCost(model!.contextWindowTokens!, row!.callConfig.proposedMaxOutputTokens!, pricing.tiers.map((tier) => ({ ...tier, cacheWriteUsdPerMillionTokens: tier.cacheWriteUsdPerMillionTokens ?? undefined })));
    return { rowId, pricing, reserve, settings: getModelGenerationSettings(model!) };
  });
  const totalReservedMicroUsd = sumCollectionMoney(calls.map((call) => call.reserve.reservedMicroUsd));
  const body = { schemaVersion: COLLECTION_VERSION, purpose: "development-only" as const, status: "proposal" as const,
    plan: input.plan, collectorSource: input.collectorSource, selectedRowIds, calls, limits,
    assumptions: [...COLLECTION_ASSUMPTIONS], totalReservedMicroUsd,
    completionPossibleWithinLimits: totalReservedMicroUsd <= limits.maxTotalMicroUsd && calls.length <= limits.maxCalls && calls.every((call) => call.reserve.reservedMicroUsd <= limits.maxRequestMicroUsd) };
  return { ...body, manifestDigest: collectionHash(body) };
}
export type CollectionManifest<Plan extends CollectionPlan = DevelopmentPlan> = ReturnType<typeof buildCollectionManifest<Plan>>;
export type CollectionApproval = {
  schemaVersion: typeof COLLECTION_VERSION; status: "approved"; approvalId: string; manifestDigest: string;
  approvedBy: string; approvedAt: string; expiresAt: string; acknowledgements: string[];
};
export function validateCollectionManifest<Plan extends CollectionPlan = DevelopmentPlan>(value: unknown, input: Omit<Parameters<typeof buildCollectionManifest<Plan>>[0], "selectedRowIds" | "limits">): CollectionManifest<Plan> {
  const obj = strictBenchmarkObject(value, ["schemaVersion", "purpose", "status", "plan", "collectorSource", "selectedRowIds", "calls", "limits", "assumptions", "totalReservedMicroUsd", "completionPossibleWithinLimits", "manifestDigest"], "collection_manifest");
  const expected = buildCollectionManifest({ ...input, selectedRowIds: obj.selectedRowIds as string[], limits: validateCollectionLimits(obj.limits) });
  if (canonicalBenchmarkJson(value) !== canonicalBenchmarkJson(expected)) collectionFail("manifest_snapshot_mismatch");
  return expected;
}
export function validateCollectionApproval(value: unknown, manifest: CollectionManifest<CollectionPlan>, now: number, allowExpired = false): CollectionApproval {
  const obj = strictBenchmarkObject(value, ["schemaVersion", "status", "approvalId", "manifestDigest", "approvedBy", "approvedAt", "expiresAt", "acknowledgements"], "collection_approval");
  collectionId(obj.approvalId);
  if (obj.schemaVersion !== COLLECTION_VERSION || obj.status !== "approved" || obj.manifestDigest !== manifest.manifestDigest || typeof obj.approvedBy !== "string" || !obj.approvedBy.trim() || obj.approvedBy.length > 200 || !isBenchmarkInstant(obj.approvedAt) || obj.expiresAt !== manifest.limits.expiresAt || canonicalBenchmarkJson(obj.acknowledgements) !== canonicalBenchmarkJson(COLLECTION_ASSUMPTIONS)) collectionFail("approval_binding");
  if (Date.parse(obj.approvedAt as string) < Date.parse(manifest.plan.createdAt) || Date.parse(obj.approvedAt as string) > now || Date.parse(obj.approvedAt as string) >= Date.parse(obj.expiresAt as string) || (!allowExpired && now >= Date.parse(obj.expiresAt as string))) collectionFail("approval_time");
  return value as CollectionApproval;
}

export type CollectionObservation = {
  source: "provider_body_allowlist" | "unavailable"; providerResponseId: string | null; providerReportedModel: string | null;
  inputTokens: number | null; outputTokens: number | null; noCacheInputTokens: number | null;
  cacheReadTokens: number | null; cacheWriteTokens: number | null; reasoningTokens: number | null;
  rawFinishReason: string | null; finish: "stop" | "length" | "blocked" | "unknown";
  servedProcessingTier: string | null; unsupportedBilling: boolean;
};
export type CollectionOutcome = {
  status: "returned" | "failed" | "timeout" | "unknown" | "measurement_unsupported";
  answerText: string | null; answerBytes: number | null; answerDigest: string | null;
  textOmitted: boolean; completeResponse: boolean; failureCode: string | null;
  latencyMs: number | null; observation: CollectionObservation;
};
export const emptyCollectionObservation = (): CollectionObservation => ({ source: "unavailable", providerResponseId: null, providerReportedModel: null, inputTokens: null, outputTokens: null, noCacheInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, rawFinishReason: null, finish: "unknown", servedProcessingTier: null, unsupportedBilling: false });
export function validateCollectionOutcome(value: unknown): CollectionOutcome {
  const obj = strictBenchmarkObject(value, ["status", "answerText", "answerBytes", "answerDigest", "textOmitted", "completeResponse", "failureCode", "latencyMs", "observation"], "collection_outcome");
  if (!["returned", "failed", "timeout", "unknown", "measurement_unsupported"].includes(obj.status as string) || typeof obj.textOmitted !== "boolean" || typeof obj.completeResponse !== "boolean") collectionFail("outcome_status");
  if (obj.failureCode !== null && (typeof obj.failureCode !== "string" || !/^[a-z0-9_]{1,100}$/.test(obj.failureCode))) collectionFail("failure_code");
  for (const key of ["answerBytes", "latencyMs"]) if (obj[key] !== null) collectionInteger(obj[key], `outcome_${key}`);
  if (typeof obj.answerText === "string") {
    if (Buffer.byteLength(obj.answerText) > COLLECTION_LIMITS.answerStorageBytes || obj.answerBytes !== Buffer.byteLength(obj.answerText) || obj.answerDigest !== benchmarkDigest(obj.answerText) || obj.textOmitted || !obj.completeResponse) collectionFail("answer_integrity");
  } else if (obj.answerText !== null || (obj.answerBytes !== null && (!obj.textOmitted || !obj.completeResponse || (obj.answerBytes as number) <= COLLECTION_LIMITS.answerStorageBytes || typeof obj.answerDigest !== "string" || !/^[a-f0-9]{64}$/.test(obj.answerDigest))) || (obj.answerBytes === null && obj.answerDigest !== null)) collectionFail("answer_omission");
  if (obj.status === "returned" && (typeof obj.answerText !== "string" || obj.failureCode !== null)) collectionFail("returned_answer_missing");
  if ((obj.status === "failed" || obj.status === "timeout") && (obj.answerText !== null || obj.answerBytes !== null || obj.failureCode === null)) collectionFail("failure_answer");
  const observation = strictBenchmarkObject(obj.observation, Object.keys(emptyCollectionObservation()), "collection_observation");
  if (!["provider_body_allowlist", "unavailable"].includes(observation.source as string) || !["stop", "length", "blocked", "unknown"].includes(observation.finish as string) || typeof observation.unsupportedBilling !== "boolean") collectionFail("observation_status");
  for (const key of ["inputTokens", "outputTokens", "noCacheInputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"]) if (observation[key] !== null) collectionInteger(observation[key], `observation_${key}`);
  for (const key of ["providerResponseId", "providerReportedModel", "rawFinishReason", "servedProcessingTier"]) if (observation[key] !== null && (typeof observation[key] !== "string" || !(observation[key] as string).length || (observation[key] as string).length > 256)) collectionFail("observation_string");
  // An unsupported parser is known locally even when every provider observation is unavailable.
  if (observation.source === "unavailable" && canonicalBenchmarkJson(observation) !== canonicalBenchmarkJson({ ...emptyCollectionObservation(), unsupportedBilling: observation.unsupportedBilling })) collectionFail("unavailable_observation_has_metrics");
  return value as CollectionOutcome;
}
export function estimateCollectionUsageCost(observation: CollectionObservation, call: CollectionManifest<CollectionPlan>["calls"][number]): number | null {
  const { inputTokens, outputTokens, noCacheInputTokens, cacheReadTokens, cacheWriteTokens } = observation;
  if (observation.unsupportedBilling || inputTokens === null || outputTokens === null || noCacheInputTokens === null || cacheReadTokens === null || cacheWriteTokens === null || noCacheInputTokens + cacheReadTokens + cacheWriteTokens !== inputTokens) return null;
  const tier = call.pricing.tiers.find((entry) => entry.maxPromptTokens === null || inputTokens <= entry.maxPromptTokens);
  if (!tier || (cacheWriteTokens > 0 && tier.cacheWriteUsdPerMillionTokens === null)) return null;
  return sumCollectionMoney([ceilTokenMicroUsd(noCacheInputTokens, tier.inputUsdPerMillionTokens), ceilTokenMicroUsd(cacheReadTokens, tier.inputUsdPerMillionTokens * tier.cachedInputPriceMultiplier), ceilTokenMicroUsd(cacheWriteTokens, tier.cacheWriteUsdPerMillionTokens ?? tier.inputUsdPerMillionTokens), ceilTokenMicroUsd(outputTokens, tier.outputUsdPerMillionTokens)]);
}
