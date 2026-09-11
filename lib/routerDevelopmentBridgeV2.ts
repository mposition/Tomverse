/** Offline v2 bridge. No provider adapter, credential access, or spending authorization. */
import type { AiModel } from "./models";
import { getModelGenerationSettings } from "./modelGenerationCompatibility";
import { filterRouterCandidates } from "./routerCandidates";
import { expectedTotalCostUsdByModel } from "./routerCostSignal";
import { selectRouterModel } from "./routerSelection";
import { buildTaskProfile } from "./taskProfileCore";
import { NO_WEB_SEARCH_BACKENDS } from "./webSearchBackends";
import { benchmarkDigest, canonicalBenchmarkJson, strictBenchmarkObject, type DevelopmentResultRow } from "./routerDevelopmentBenchmark";
import type { DevelopmentSource } from "./routerDevelopmentBenchmarkPlan";
import { gradeDevelopmentV2Answer, type DevelopmentCorpusV2, type DevelopmentPartitionsV2 } from "./routerDevelopmentCorpusV2";
import { validateDevelopmentPlanV2, type DevelopmentPlanV2 } from "./routerDevelopmentPlanV2";
import { validateDevelopmentResultsV2, scoreDevelopmentResultsV2 } from "./routerDevelopmentResultsV2";
import { buildCollectionManifest, validateCollectionManifest, validateCollectionApproval, COLLECTION_ASSUMPTIONS, COLLECTION_LIMITS, COLLECTION_VERSION,
  type CollectionApproval, type CollectionLimits } from "./routerDevelopmentCollector";
import { replayCollectionJournal, exportDevelopmentCollectionRows, type CollectionRunInput } from "./routerDevelopmentCollectorJournal";
import { buildDevelopmentExecutionContract, buildDevelopmentExecutionObservation, validateDevelopmentExecutionContract, validateDevelopmentExecutionObservation,
  executionContractMismatches, executionObservationCompatibility, DEVELOPMENT_EXECUTION_VERSION,
  type DevelopmentExecutionContract } from "./routerDevelopmentExecution";
import { validateReplayPolicy, selectReplayCandidate, replayGenerationContract, replayContractMismatches, summarizeReplayPairs } from "./routerDevelopmentReplay";

export const MOCK_MANIFEST_V2_VERSION = "router-development-mock-manifest-v2";
export const MOCK_REPLAY_V2_VERSION = "router-development-mock-replay-v2";
const hash = (value: unknown) => benchmarkDigest(canonicalBenchmarkJson(value));
const fail = (code: string): never => { throw new Error(`bridge_v2_${code}`); };
export type BridgeContextV2 = {
  corpus: DevelopmentCorpusV2; partitions: DevelopmentPartitionsV2; models: readonly AiModel[];
  benchmarkSource: DevelopmentSource; collectorSource: DevelopmentSource;
};

export function buildMockManifestV2(input: BridgeContextV2 & {
  plan: DevelopmentPlanV2; selectedRowIds: readonly string[]; limits: CollectionLimits;
}) {
  if (input.benchmarkSource.dirty || input.collectorSource.dirty || input.benchmarkSource.commit !== input.collectorSource.commit) fail("source_not_frozen");
  const plan = validateDevelopmentPlanV2(input.plan, { corpus: input.corpus, partitions: input.partitions, models: input.models, source: input.benchmarkSource });
  const collection = buildCollectionManifest({ plan, models: input.models, collectorSource: input.collectorSource,
    selectedRowIds: input.selectedRowIds, limits: input.limits });
  const body = { schemaVersion: MOCK_MANIFEST_V2_VERSION, purpose: "development-only" as const,
    evidenceStatus: "mock_validation_only" as const, collection };
  return { ...body, wrapperDigest: hash(body) };
}
export type MockManifestV2 = ReturnType<typeof buildMockManifestV2>;

export function validateMockManifestV2(value: unknown, context: BridgeContextV2): MockManifestV2 {
  const wrapper = strictBenchmarkObject(value, ["schemaVersion", "purpose", "evidenceStatus", "collection", "wrapperDigest"], "mock_manifest_v2");
  if (wrapper.schemaVersion !== MOCK_MANIFEST_V2_VERSION || wrapper.purpose !== "development-only" || wrapper.evidenceStatus !== "mock_validation_only") fail("manifest_scope");
  const candidate = strictBenchmarkObject(wrapper.collection, ["schemaVersion", "purpose", "status", "plan", "collectorSource", "selectedRowIds", "calls", "limits", "assumptions", "totalReservedMicroUsd", "completionPossibleWithinLimits", "manifestDigest"], "mock_collection_v2");
  const plan = validateDevelopmentPlanV2(candidate.plan, { corpus: context.corpus, partitions: context.partitions, models: context.models, source: context.benchmarkSource });
  const collection = validateCollectionManifest(candidate, { plan, models: context.models, collectorSource: context.collectorSource });
  const expected = buildMockManifestV2({ ...context, plan, selectedRowIds: collection.selectedRowIds, limits: collection.limits });
  if (canonicalBenchmarkJson(value) !== canonicalBenchmarkJson(expected)) fail("manifest_snapshot_mismatch");
  return expected;
}

/** Synthetic protocol fixture only. The distinct manifest cannot enter the v1 live CLI. */
export function mockApprovalV2(manifest: MockManifestV2, suffix: "main" | "unknown" | "other" = "main"): CollectionApproval {
  return { schemaVersion: COLLECTION_VERSION, status: "approved", approvalId: `mock-v2-${suffix}`,
    manifestDigest: manifest.collection.manifestDigest, approvedBy: "SYNTHETIC V2 MOCK ONLY; NOT HUMAN SPENDING AUTHORIZATION",
    approvedAt: manifest.collection.plan.createdAt, expiresAt: manifest.collection.limits.expiresAt,
    acknowledgements: [...COLLECTION_ASSUMPTIONS] };
}
function validateMockApproval(value: CollectionApproval, manifest: MockManifestV2, instant: number) {
  validateCollectionApproval(value, manifest.collection, instant, true);
  if (!["mock-v2-main", "mock-v2-unknown", "mock-v2-other"].includes(value.approvalId)
    || value.approvedBy !== mockApprovalV2(manifest).approvedBy || value.approvedAt !== manifest.collection.plan.createdAt) fail("approval_not_mock");
}

export function collectionExecutionContractsV2(context: BridgeContextV2 & { manifest: unknown }): DevelopmentExecutionContract[] {
  const manifest = validateMockManifestV2(context.manifest, context).collection;
  const plan = manifest.plan;
  return manifest.calls.map((call) => {
    const row = plan.rows.find((candidate) => candidate.rowId === call.rowId)!;
    return buildDevelopmentExecutionContract({ schemaVersion: DEVELOPMENT_EXECUTION_VERSION, purpose: "development-only", rowId: row.rowId,
      sourceCommit: plan.source.commit, benchmarkSourceDigest: hash(plan.source), collectorSourceDigest: hash(manifest.collectorSource),
      corpusDigest: plan.corpusDigest, catalogueDigest: plan.catalogueDigest, policyDigest: hash({ versions: plan.versions, partitionDigest: plan.partitionDigest }),
      planDigest: plan.planDigest, manifestDigest: manifest.manifestDigest, promptDigest: row.promptDigest,
      contextKind: "none", contextDigest: hash(null), contextProvenanceDigest: hash(null),
      modelId: row.modelId, provider: row.provider, apiModel: row.apiModel, callConfigDigest: row.callConfigDigest,
      maxOutputTokens: call.reserve.outputCapTokens, generationSettingsDigest: hash(call.settings), collectorVersion: COLLECTION_VERSION,
      plannerVersion: "none", search: false, tools: false, attachments: false, maxRetries: 0 });
  });
}

export function validateExecutionObservationSetV2(values: readonly unknown[], contracts: readonly DevelopmentExecutionContract[], input: BridgeContextV2 & {
  journalText: string; manifest: unknown; approval: CollectionApproval;
}) {
  if (!Array.isArray(values) || !Array.isArray(contracts) || values.length > contracts.length) fail("observation_count");
  if (typeof input.journalText !== "string" || Buffer.byteLength(input.journalText) > COLLECTION_LIMITS.journalBytes) fail("journal_text_limit");
  const manifest = validateMockManifestV2(input.manifest, input);
  const authoritative = new Map(collectionExecutionContractsV2({ ...input, manifest }).map((contract) => [contract.rowId, contract]));
  const supplied = new Map(contracts.map((contract) => [validateDevelopmentExecutionContract(contract).rowId, contract]));
  if (supplied.size !== contracts.length) fail("duplicate_contract");
  const journal = replayCollectionJournal(input.journalText, manifest.collection, input.approval);
  validateMockApproval(input.approval, manifest, Date.parse(journal.startedAt));
  for (const contract of contracts) {
    const expected = authoritative.get(contract.rowId);
    if (!expected || executionContractMismatches(expected, contract).length) fail("contract_snapshot_mismatch");
  }
  const terminals = new Map(journal.entries.filter((entry) => entry.event.kind === "terminal").map((entry) => [entry.entryDigest, entry]));
  const observed = new Map<string, ReturnType<typeof validateDevelopmentExecutionObservation>>();
  for (const value of values) {
    const observation = validateDevelopmentExecutionObservation(value);
    if (observation.provenance !== "mock-only") fail("observation_not_mock");
    if (observed.has(observation.rowId)) fail("duplicate_observation");
    if (!supplied.has(observation.rowId)) fail("unknown_observation");
    const terminal = terminals.get(observation.journalEntryDigest)?.event;
    if (!terminal || terminal.kind !== "terminal" || terminal.rowId !== observation.rowId || terminal.at !== observation.recordedAt
      || canonicalBenchmarkJson(terminal.outcome) !== canonicalBenchmarkJson(observation.outcome)) fail("journal_observation_binding");
    observed.set(observation.rowId, observation);
  }
  return contracts.map((contract) => {
    const observation = observed.get(contract.rowId) ?? null;
    return { rowId: contract.rowId, observation, compatibility: executionObservationCompatibility({ expected: contract, observed: contract, observation }) };
  });
}

export async function exportMockResultsV2(input: CollectionRunInput<DevelopmentPlanV2> & BridgeContextV2 & { mockManifest: unknown }) {
  const manifest = validateMockManifestV2(input.mockManifest, input);
  if (canonicalBenchmarkJson(input.manifest) !== canonicalBenchmarkJson(manifest.collection)) fail("export_manifest_binding");
  validateMockApproval(input.approval, manifest, (input.now ?? Date.now)());
  const contracts = new Map(collectionExecutionContractsV2({ ...input, manifest }).map((contract) => [contract.rowId, contract]));
  const rows = await exportDevelopmentCollectionRows(input, (receipt) => {
    const contract = contracts.get(receipt.rowId)!;
    const observation = buildDevelopmentExecutionObservation({ ...receipt, executionDigest: contract.contractDigest, provenance: "mock-only" });
    if (executionObservationCompatibility({ expected: contract, observed: contract, observation }).disposition !== "compatible") fail("export_execution_held");
  });
  // Only new mock protocol records cross this boundary. Never normalize historical evidence.
  for (const row of rows) {
    if (row.providerResponseId !== null || row.modelVersion !== null || Object.values(row.metrics).some((value) => value !== null)) fail("mock_claims_measurement");
  }
  return validateDevelopmentResultsV2({ schemaVersion: "router-development-results-v2", purpose: "development-only",
    corpusDigest: manifest.collection.plan.corpusDigest, partitionDigest: manifest.collection.plan.partitionDigest,
    planDigest: manifest.collection.plan.planDigest,
    origin: { kind: "synthetic-fixture", description: `Fixed v2 mock adapter; no provider calls or measured usage, timing or spend. Manifest ${manifest.collection.manifestDigest}.` },
    rows: rows.map((row) => ({ ...row, recordedAt: null })) }, manifest.collection.plan);
}

type ChoiceV2 = {
  modelId: string | null; rowId: string | null; reason: string; available: boolean;
  unavailableReason: "no_router_candidate" | "benchmark_refused" | "not_selected_for_collection" | "not_observed" | null;
  contractDigest: string | null; outcome: "correct" | "incorrect" | "blank" | "invalid_json" | "failed" | "timeout" | null;
  failureCode: string | null; historicalMetrics: DevelopmentResultRow["metrics"] | null;
};
function choiceSummary(choices: ChoiceV2[]) {
  const available = choices.filter((choice) => choice.available);
  const count = (value: ChoiceV2["outcome"]) => available.filter((choice) => choice.outcome === value).length;
  return { populationCases: choices.length, availableCases: available.length, unavailableCases: choices.length - available.length,
    correct: count("correct"), incorrect: count("incorrect"), blank: count("blank"), invalidJson: count("invalid_json"), failed: count("failed"), timeout: count("timeout"),
    coverage: choices.length ? available.length / choices.length : null,
    wholePopulationCorrectOutcomeShare: choices.length && choices.length === available.length ? count("correct") / choices.length : null,
    inputTokens: null, outputTokens: null, latencyMs: null, providerCostUsd: null };
}

/** Static selection runs before the grader and receives only the gold-free frozen plan. */
export function selectReplayModelsV2(plan: DevelopmentPlanV2, models: readonly AiModel[], candidate: unknown) {
  const policy = validateReplayPolicy(candidate, models.map((model) => model.id));
  return plan.byCase.map(({ caseId }) => {
    const rows = plan.rows.filter((row) => row.caseId === caseId);
    const first = rows[0];
    const profile = buildTaskProfile({ text: first.input.prompt });
    const admission = filterRouterCandidates({ models, profile, plan: plan.inputs.plan, searchBackendReadiness: NO_WEB_SEARCH_BACKENDS,
      reservedInputTokens: first.router.originalReservedInputTokens, requestOutputCapTokens: first.router.originalRequestOutputCapTokens });
    const baseline = selectRouterModel({ profile, eligible: admission.eligible, sticky: null,
      signals: { expectedTotalCostUsdByModelId: expectedTotalCostUsdByModel({ models,
        reservedInputTokens: first.router.originalReservedInputTokens, requestOutputCapTokens: first.router.originalRequestOutputCapTokens }) } });
    const frozen = rows.filter((row) => row.router.selected);
    if (frozen.length > 1 || (frozen[0]?.modelId ?? null) !== baseline.selectedModelId
      || rows.some((row) => row.router.eligible !== admission.eligible.some((entry) => entry.modelId === row.modelId)
        || row.router.taskKind !== profile.kind || row.router.needsCurrentInformation !== profile.needsCurrentInformation)) fail("original_router_mismatch");
    const selected = selectReplayCandidate({ profile, eligible: admission.eligible, baselineModelId: baseline.selectedModelId, policy });
    return { caseId, profile, baseline: { modelId: baseline.selectedModelId, reason: baseline.reason }, candidate: selected };
  });
}

export function replayMockDevelopmentV2(input: BridgeContextV2 & {
  manifest: unknown; answers: unknown; candidate: unknown; replaySource: DevelopmentSource;
  contracts: readonly DevelopmentExecutionContract[]; observations: readonly unknown[]; journalText: string; approval: CollectionApproval;
}) {
  const manifest = validateMockManifestV2(input.manifest, input);
  const plan = manifest.collection.plan;
  const answers = validateDevelopmentResultsV2(input.answers, plan);
  if (answers.rows.some((row) => !manifest.collection.selectedRowIds.includes(row.rowId))) fail("answer_outside_selection");
  const receipts = new Map(validateExecutionObservationSetV2(input.observations, input.contracts, input).map((entry) => [entry.rowId, entry]));
  for (const row of answers.rows) {
    const receipt = receipts.get(row.rowId);
    if (!receipt?.observation || receipt.compatibility.disposition !== "compatible") return fail("replay_execution_held");
    const outcome = receipt.observation.outcome;
    const status = outcome.status === "returned" ? "succeeded" : outcome.status;
    if (row.status !== status || row.answerText !== outcome.answerText || row.answerDigest !== outcome.answerDigest || row.failureCode !== outcome.failureCode) fail("replay_answer_receipt_mismatch");
  }
  const selection = selectReplayModelsV2(plan, input.models, input.candidate);
  const policy = validateReplayPolicy(input.candidate, input.models.map((model) => model.id));
  const cases = new Map(input.corpus.cases.map((item) => [item.id, item]));
  const rows = selection.map((selected) => {
    const item = cases.get(selected.caseId)!;
    const planned = plan.rows.filter((row) => row.caseId === item.id);
    const observe = (choice: { modelId: string | null; reason: string }): ChoiceV2 => {
      const row = planned.find((row) => row.modelId === choice.modelId);
      const empty: ChoiceV2 = { ...choice, rowId: row?.rowId ?? null, available: false, unavailableReason: null, contractDigest: null, outcome: null, failureCode: null, historicalMetrics: null };
      if (!row) return { ...empty, unavailableReason: "no_router_candidate" };
      if (!row.benchmarkEligibility.eligible) return { ...empty, unavailableReason: "benchmark_refused" };
      const call = manifest.collection.calls.find((call) => call.rowId === row.rowId);
      if (!call) return { ...empty, unavailableReason: "not_selected_for_collection" };
      const model = input.models.find((model) => model.id === row.modelId)!;
      const expected = replayGenerationContract(row, getModelGenerationSettings(model));
      const contract = replayGenerationContract(row, call.settings);
      if (call.reserve.outputCapTokens !== expected.maxOutputTokens || replayContractMismatches(expected, contract).length) fail("generation_contract_mismatch");
      empty.contractDigest = hash(contract);
      const saved = answers.rows.find((saved) => saved.rowId === row.rowId);
      if (!saved) return { ...empty, unavailableReason: "not_observed" };
      const grade = saved.status === "succeeded" ? gradeDevelopmentV2Answer(item, saved.answerText!) : null;
      const outcome = saved.status !== "succeeded" ? saved.status : grade!.reason === "exact_match" ? "correct" : grade!.reason === "value_mismatch" ? "incorrect" : grade!.reason === "blank_answer" ? "blank" : "invalid_json";
      return { ...empty, available: true, outcome, failureCode: saved.failureCode, historicalMetrics: saved.metrics };
    };
    const compatibility = (modelId: string | null) => {
      const row = planned.find((row) => row.modelId === modelId);
      const reasons = !row ? ["no_router_candidate"] : [
        ...(!row.router.eligible ? ["original_router_ineligible"] : []),
        ...(!row.benchmarkEligibility.eligible ? ["benchmark_refused"] : []),
        ...(row.router.originalFittedOutputTokens !== row.callConfig.proposedMaxOutputTokens ? ["original_router_output_cap_differs"] : []),
        ...(selected.profile.needsCurrentInformation ? ["original_profile_search_not_collected"] : []),
        ...(selected.profile.hasImageInput || selected.profile.hasDocumentInput ? ["original_profile_attachments_not_collected"] : [])];
      return { modelId, comparedFieldsCompatible: reasons.length === 0, reasons, productExecutionVerified: false };
    };
    return { caseId: item.id, language: item.language, task: item.task, difficulty: item.difficulty, familyId: item.familyId,
      partition: planned[0].partition, baseline: observe(selected.baseline), candidate: observe(selected.candidate),
      productCompatibility: { baseline: compatibility(selected.baseline.modelId), candidate: compatibility(selected.candidate.modelId) } };
  });
  const summarize = (group: typeof rows) => ({ baseline: choiceSummary(group.map((row) => row.baseline)),
    candidate: choiceSummary(group.map((row) => row.candidate)), paired: summarizeReplayPairs(group) });
  const score = scoreDevelopmentResultsV2(input.corpus, input.partitions, plan, answers);
  return { schemaVersion: MOCK_REPLAY_V2_VERSION, purpose: "development-only", evidenceStatus: "mock_validation_only",
    providerCallsByThisTool: 0, incurredProviderSpendUsdByThisTool: 0, productExecutionVerified: false, productPerformanceDelta: null,
    observationSource: { benchmark: input.benchmarkSource, collector: input.collectorSource, corpusDigest: plan.corpusDigest,
      partitionDigest: plan.partitionDigest, planDigest: plan.planDigest, manifestDigest: manifest.collection.manifestDigest, wrapperDigest: manifest.wrapperDigest, answersDigest: hash(answers) },
    replaySource: input.replaySource, candidate: { ...policy, policyDigest: hash(policy) },
    observationBundle: { catalogueModels: plan.models.length, catalogueRows: plan.rows.length,
      manifestSelectedRows: manifest.collection.selectedRowIds.length, importedRows: answers.rows.length, originalScoreSummary: score.summary },
    benchmarkDomain: { ...summarize(rows), rows: rows.map((row) => ({ caseId: row.caseId, language: row.language, task: row.task,
      difficulty: row.difficulty, familyId: row.familyId, partition: row.partition, baseline: row.baseline, candidate: row.candidate })) },
    byCell: ["en", "ko"].flatMap((language) => ["structured-extraction", "grounded-calculation"].flatMap((task) => ["basic", "advanced"].map((difficulty) => ({ language, task, difficulty,
      ...summarize(rows.filter((row) => row.language === language && row.task === task && row.difficulty === difficulty)) })))),
    byPartition: ["tuning", "development-validation"].map((partition) => ({ partition, ...summarize(rows.filter((row) => row.partition === partition)) })),
    byFamily: input.partitions.families.map(({ familyId, partition }) => ({ familyId, partition, ...summarize(rows.filter((row) => row.familyId === familyId)) })),
    productCompatibility: { productExecutionVerified: false, productPerformanceDelta: null, populationCases: rows.length,
      rows: rows.map((row) => ({ caseId: row.caseId, ...row.productCompatibility })) },
    limitations: ["Fixed synthetic stub outcomes validate plumbing only; no model quality, ranking, independent sample, ROUTE-01 or product-performance claim.",
      "Every catalogue row remains in the separate score. Paired Replay coverage is a different denominator from full catalogue coverage.",
      "Mock timings, token usage and provider-billed cost are unmeasured and null. Synthetic approval is not human spending authorization."] };
}
