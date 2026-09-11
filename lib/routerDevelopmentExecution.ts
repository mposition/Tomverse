/** Development-only compatibility. Digests bind local records, not provider authenticity. */
import type { AiModel } from "./models";
import {
  benchmarkDigest, canonicalBenchmarkJson, isBenchmarkDigest, isBenchmarkInstant,
  parseBenchmarkJson, strictBenchmarkObject, validateDevelopmentResults, type DevelopmentCorpus,
} from "./routerDevelopmentBenchmark";
import { validateDevelopmentPlan, type DevelopmentPlan, type DevelopmentSource } from "./routerDevelopmentBenchmarkPlan";
import {
  COLLECTION_LIMITS, COLLECTION_VERSION, validateCollectionApproval, validateCollectionManifest, validateCollectionOutcome,
  type CollectionApproval, type CollectionManifest, type CollectionOutcome,
} from "./routerDevelopmentCollector";
import { replayCollectionJournal } from "./routerDevelopmentCollectorJournal";

export const DEVELOPMENT_EXECUTION_VERSION = "router-development-execution-v2";
export const DEVELOPMENT_OBSERVATION_VERSION = "router-development-observation-v2";
export const EXECUTION_LIMITS = { contractBytes: 16_384, observationBytes: 2_097_152 } as const;
const hash = (value: unknown) => benchmarkDigest(canonicalBenchmarkJson(value));
const NONE_DIGEST = hash(null);
const fail = (code: string): never => { throw new Error(`execution_${code}`); };

export type DevelopmentExecutionContract = {
  schemaVersion: typeof DEVELOPMENT_EXECUTION_VERSION; purpose: "development-only";
  rowId: string; sourceCommit: string; benchmarkSourceDigest: string; collectorSourceDigest: string;
  corpusDigest: string; catalogueDigest: string; policyDigest: string; planDigest: string; manifestDigest: string;
  promptDigest: string; contextKind: "none" | "supplied-text";
  contextDigest: string; contextProvenanceDigest: string;
  modelId: string; provider: string; apiModel: string; callConfigDigest: string;
  maxOutputTokens: number; generationSettingsDigest: string;
  collectorVersion: typeof COLLECTION_VERSION; plannerVersion: "none";
  search: boolean; tools: boolean; attachments: boolean; maxRetries: 0;
  contractDigest: string;
};
const CONTRACT_FIELDS = [
  "schemaVersion", "purpose", "rowId", "sourceCommit", "benchmarkSourceDigest", "collectorSourceDigest",
  "corpusDigest", "catalogueDigest", "policyDigest", "planDigest", "manifestDigest", "promptDigest",
  "contextKind", "contextDigest", "contextProvenanceDigest", "modelId", "provider", "apiModel", "callConfigDigest",
  "maxOutputTokens", "generationSettingsDigest", "collectorVersion", "plannerVersion", "search", "tools",
  "attachments", "maxRetries", "contractDigest",
] as const;
type ContractBody = Omit<DevelopmentExecutionContract, "contractDigest">;

function boundedCanonical(value: unknown, maximum: number): string {
  const text = canonicalBenchmarkJson(value);
  if (Buffer.byteLength(text) > maximum) fail("document_byte_limit");
  return text;
}

export function validateDevelopmentExecutionContract(value: unknown): DevelopmentExecutionContract {
  boundedCanonical(value, EXECUTION_LIMITS.contractBytes);
  const obj = strictBenchmarkObject(value, CONTRACT_FIELDS, "execution_contract");
  if (obj.schemaVersion !== DEVELOPMENT_EXECUTION_VERSION || obj.purpose !== "development-only"
    || obj.collectorVersion !== COLLECTION_VERSION || obj.plannerVersion !== "none" || obj.maxRetries !== 0) fail("version_or_scope");
  if (typeof obj.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(obj.sourceCommit)) fail("source_commit");
  for (const key of CONTRACT_FIELDS.filter((key) => key.endsWith("Digest"))) if (!isBenchmarkDigest(obj[key])) fail("digest_format");
  for (const key of ["rowId", "modelId", "provider", "apiModel"]) {
    if (typeof obj[key] !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(obj[key] as string)) fail("identity_format");
  }
  if (!Number.isSafeInteger(obj.maxOutputTokens) || (obj.maxOutputTokens as number) < 1) fail("output_cap");
  for (const key of ["search", "tools", "attachments"]) if (typeof obj[key] !== "boolean") fail("mode_type");
  if (obj.contextKind !== "none" && obj.contextKind !== "supplied-text") fail("context_kind");
  if (obj.contextKind === "none" && (obj.contextDigest !== NONE_DIGEST || obj.contextProvenanceDigest !== NONE_DIGEST)) fail("absent_context_binding");
  if (obj.contextKind === "supplied-text" && (obj.contextDigest === NONE_DIGEST || obj.contextProvenanceDigest === NONE_DIGEST)) fail("supplied_context_binding");
  const { contractDigest, ...body } = obj;
  if (contractDigest !== hash(body)) fail("contract_digest_mismatch");
  return value as DevelopmentExecutionContract;
}

export function buildDevelopmentExecutionContract(body: ContractBody): DevelopmentExecutionContract {
  return validateDevelopmentExecutionContract({ ...body, contractDigest: hash(body) });
}
export const parseDevelopmentExecutionContract = (text: string) =>
  validateDevelopmentExecutionContract(parseBenchmarkJson(text, EXECUTION_LIMITS.contractBytes));

/** Reconstruct the original plan and manifest; callers supply independently selected source snapshots. */
export function collectionExecutionContracts(input: {
  corpus: DevelopmentCorpus; models: readonly AiModel[]; manifest: unknown;
  benchmarkSource: DevelopmentSource; collectorSource: DevelopmentSource;
}): DevelopmentExecutionContract[] {
  if (input.benchmarkSource.dirty || input.collectorSource.dirty || input.benchmarkSource.commit !== input.collectorSource.commit) fail("source_not_frozen");
  const candidate = input.manifest as { plan?: unknown } | null;
  const plan = validateDevelopmentPlan(candidate?.plan, { corpus: input.corpus, models: input.models, source: input.benchmarkSource });
  const manifest = validateCollectionManifest(input.manifest, { plan, models: input.models, collectorSource: input.collectorSource });
  return manifest.calls.map((call) => {
    const row = plan.rows.find((row) => row.rowId === call.rowId)!;
    return buildDevelopmentExecutionContract({
      schemaVersion: DEVELOPMENT_EXECUTION_VERSION, purpose: "development-only", rowId: row.rowId,
      sourceCommit: plan.source.commit, benchmarkSourceDigest: hash(plan.source), collectorSourceDigest: hash(manifest.collectorSource),
      corpusDigest: plan.corpusDigest, catalogueDigest: plan.catalogueDigest, policyDigest: hash(plan.versions),
      planDigest: plan.planDigest, manifestDigest: manifest.manifestDigest, promptDigest: row.promptDigest,
      contextKind: "none", contextDigest: NONE_DIGEST, contextProvenanceDigest: NONE_DIGEST,
      modelId: row.modelId, provider: row.provider, apiModel: row.apiModel, callConfigDigest: row.callConfigDigest,
      maxOutputTokens: call.reserve.outputCapTokens, generationSettingsDigest: hash(call.settings),
      collectorVersion: COLLECTION_VERSION, plannerVersion: "none", search: false, tools: false, attachments: false, maxRetries: 0,
    });
  });
}

/** Unsupported modes remain inspectable refusals, never capabilities granted by a hash. */
export function executionContractRefusals(value: unknown): string[] {
  const contract = validateDevelopmentExecutionContract(value);
  return (["search", "tools", "attachments"] as const).filter((key) => contract[key]).map((key) => `${key}_unsupported`);
}

export function executionContractMismatches(expectedValue: unknown, observedValue: unknown): string[] {
  const expected = validateDevelopmentExecutionContract(expectedValue);
  const observed = validateDevelopmentExecutionContract(observedValue);
  // Same comparison pattern as replayContractMismatches, with a versioned, strict field set.
  return CONTRACT_FIELDS.filter((key) => key !== "contractDigest" && canonicalBenchmarkJson(expected[key]) !== canonicalBenchmarkJson(observed[key]));
}

export type DevelopmentExecutionObservation = {
  schemaVersion: typeof DEVELOPMENT_OBSERVATION_VERSION; purpose: "development-only";
  executionDigest: string; rowId: string; recordedAt: string;
  provenance: "mock-only" | "local-collector-unverified"; journalEntryDigest: string;
  outcome: CollectionOutcome;
  // The reused collector measures none of these. New measurement paths need a new schema.
  ttftMs: null; endToEndLatencyMs: null; providerBilledCostUsd: null;
  observationDigest: string;
};
const OBSERVATION_FIELDS = ["schemaVersion", "purpose", "executionDigest", "rowId", "recordedAt", "provenance", "journalEntryDigest", "outcome", "ttftMs", "endToEndLatencyMs", "providerBilledCostUsd", "observationDigest"] as const;

export function validateDevelopmentExecutionObservation(value: unknown): DevelopmentExecutionObservation {
  boundedCanonical(value, EXECUTION_LIMITS.observationBytes);
  const obj = strictBenchmarkObject(value, OBSERVATION_FIELDS, "execution_observation");
  if (obj.schemaVersion !== DEVELOPMENT_OBSERVATION_VERSION || obj.purpose !== "development-only"
    || !["mock-only", "local-collector-unverified"].includes(obj.provenance as string)) fail("observation_scope");
  if (!isBenchmarkInstant(obj.recordedAt) || typeof obj.rowId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(obj.rowId)) fail("observation_identity_or_time");
  for (const key of ["executionDigest", "journalEntryDigest", "observationDigest"]) if (!isBenchmarkDigest(obj[key])) fail("digest_format");
  for (const key of ["ttftMs", "endToEndLatencyMs", "providerBilledCostUsd"]) if (obj[key] !== null) fail("unsupported_metric");
  const outcome = validateCollectionOutcome(obj.outcome);
  if (obj.provenance === "mock-only" && (outcome.latencyMs !== null
    || ["providerResponseId", "providerReportedModel", "inputTokens", "outputTokens", "noCacheInputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "servedProcessingTier"]
      .some((key) => outcome.observation[key as keyof typeof outcome.observation] !== null))) fail("mock_claims_provider_measurement");
  const { observationDigest, ...body } = obj;
  if (observationDigest !== hash(body)) fail("observation_digest_mismatch");
  return value as DevelopmentExecutionObservation;
}
export function buildDevelopmentExecutionObservation(body: Omit<DevelopmentExecutionObservation, "schemaVersion" | "purpose" | "ttftMs" | "endToEndLatencyMs" | "providerBilledCostUsd" | "observationDigest">): DevelopmentExecutionObservation {
  const value = { ...body, schemaVersion: DEVELOPMENT_OBSERVATION_VERSION, purpose: "development-only", ttftMs: null, endToEndLatencyMs: null, providerBilledCostUsd: null };
  return validateDevelopmentExecutionObservation({ ...value, observationDigest: hash(value) });
}
export const parseDevelopmentExecutionObservation = (text: string) =>
  validateDevelopmentExecutionObservation(parseBenchmarkJson(text, EXECUTION_LIMITS.observationBytes));

export function executionObservationCompatibility(input: { expected: unknown; observed: unknown; observation: unknown | null }) {
  const expected = validateDevelopmentExecutionContract(input.expected);
  const observed = validateDevelopmentExecutionContract(input.observed);
  const mismatches = executionContractMismatches(expected, observed);
  const refusals = [...new Set([...executionContractRefusals(expected), ...executionContractRefusals(observed)])];
  const observation = input.observation === null ? null : validateDevelopmentExecutionObservation(input.observation);
  if (observation && (observation.executionDigest !== observed.contractDigest || observation.rowId !== observed.rowId)) fail("observation_contract_binding");
  const common = { comparedFieldsCompatible: mismatches.length === 0, mismatches, refusals, productExecutionVerified: false, productPerformanceDelta: null };
  if (mismatches.length || refusals.length) return { ...common, disposition: "incompatible" as const, outcomeClass: null, holdReasons: [] };
  if (!observation) return { ...common, disposition: "hold" as const, outcomeClass: null, holdReasons: ["not_observed"] };
  const { outcome } = observation;
  const reasons: string[] = [];
  if (outcome.observation.unsupportedBilling) reasons.push("measurement_unsupported");
  if ((outcome.observation.outputTokens ?? 0) > expected.maxOutputTokens || (outcome.observation.reasoningTokens ?? 0) > expected.maxOutputTokens) reasons.push("observed_output_bound_exceeded");
  if (["unknown", "measurement_unsupported"].includes(outcome.status)) reasons.push("acquisition_unknown_or_unsupported");
  if (outcome.status === "returned") {
    if (!outcome.completeResponse || outcome.textOmitted || outcome.observation.finish === "length") reasons.push("incomplete_response");
    else if (outcome.observation.finish !== "stop") reasons.push("completion_not_confirmed");
  }
  if (reasons.length) return { ...common, disposition: "hold" as const, outcomeClass: null, holdReasons: reasons };
  return { ...common, disposition: "compatible" as const,
    outcomeClass: outcome.status === "returned" ? "gradeable_returned_answer" : outcome.status === "timeout" ? "acquisition_timeout" : "acquisition_failure",
    holdReasons: [],
  };
}

/** A v1 success has no generation-completion or context receipt. Never invent those fields. */
export function legacyExecutionObservationStatus(value: unknown, plan: DevelopmentPlan) {
  const results = validateDevelopmentResults(value, plan);
  return { disposition: "hold" as const, reason: "v1_result_has_no_execution_context_or_completion_receipt",
    importedRows: results.rows.length, productExecutionVerified: false };
}

/** Reconstruct the frozen plan/manifest and replay the raw journal before accepting any receipt. */
export function validateExecutionObservationSet(values: readonly unknown[], contracts: readonly DevelopmentExecutionContract[], input: {
  journalText: string; manifest: CollectionManifest; approval: CollectionApproval;
  corpus: DevelopmentCorpus; models: readonly AiModel[];
  benchmarkSource: DevelopmentSource; collectorSource: DevelopmentSource;
}) {
  if (!Array.isArray(values) || values.length > contracts.length) fail("observation_count");
  const byRow = new Map(contracts.map((contract) => [validateDevelopmentExecutionContract(contract).rowId, contract]));
  if (byRow.size !== contracts.length) fail("duplicate_contract");
  const journalInput = strictBenchmarkObject(input, ["journalText", "manifest", "approval", "corpus", "models", "benchmarkSource", "collectorSource"], "execution_journal_input");
  const journalText = journalInput.journalText;
  if (typeof journalText !== "string" || Buffer.byteLength(journalText) > COLLECTION_LIMITS.journalBytes) return fail("journal_text_type_or_byte_limit");
  const { manifestDigest, ...manifestBody } = input.manifest;
  if (!isBenchmarkDigest(manifestDigest) || hash(manifestBody) !== manifestDigest) fail("journal_manifest_digest");
  const authoritative = new Map(collectionExecutionContracts(input).map((contract) => [contract.rowId, contract]));
  const journal = replayCollectionJournal(journalText, input.manifest, input.approval);
  validateCollectionApproval(input.approval, input.manifest, Date.parse(journal.startedAt), true);
  const header = journal.entries[0]?.event;
  if (header?.kind !== "header" || contracts.some((contract) => contract.manifestDigest !== header.manifestDigest)) fail("journal_manifest_binding");
  for (const contract of contracts) {
    const expected = authoritative.get(contract.rowId);
    if (!expected || executionContractMismatches(expected, contract).length) fail("journal_contract_snapshot_mismatch");
  }
  const terminals = new Map(journal.entries.filter((entry) => entry.event.kind === "terminal").map((entry) => [entry.entryDigest, entry]));
  const byObservedRow = new Map<string, DevelopmentExecutionObservation>();
  for (const value of values) {
    const observation = validateDevelopmentExecutionObservation(value);
    if (byObservedRow.has(observation.rowId)) fail("duplicate_observation");
    byObservedRow.set(observation.rowId, observation);
    const contract = byRow.get(observation.rowId);
    if (!contract) fail("unknown_observation");
    const receipt = terminals.get(observation.journalEntryDigest)?.event;
    if (!receipt || receipt.kind !== "terminal" || receipt.rowId !== observation.rowId || receipt.at !== observation.recordedAt
      || canonicalBenchmarkJson(receipt.outcome) !== canonicalBenchmarkJson(observation.outcome)) fail("journal_observation_binding");
  }
  return contracts.map((contract) => {
    const observation = byObservedRow.get(contract.rowId) ?? null;
    const compatibility = executionObservationCompatibility({ expected: contract, observed: contract, observation });
    return { rowId: contract.rowId, observation, compatibility };
  });
}
