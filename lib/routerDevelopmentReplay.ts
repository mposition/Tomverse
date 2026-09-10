/** Offline selection comparison under frozen benchmark calls, never product dispatch. */
import type { AiModel } from "./models";
import { getModelGenerationSettings } from "./modelGenerationCompatibility";
import { filterRouterCandidates, type RouterCandidate } from "./routerCandidates";
import { expectedTotalCostUsdByModel } from "./routerCostSignal";
import { selectRouterModel, type RouterSelectionResult } from "./routerSelection";
import { buildTaskProfile, TASK_KINDS, type TaskKind, type TaskProfile } from "./taskProfileCore";
import { NO_WEB_SEARCH_BACKENDS } from "./webSearchBackends";
import {
  benchmarkDigest, canonicalBenchmarkJson, gradeDevelopmentAnswer, scoreDevelopmentResults,
  strictBenchmarkObject, validateDevelopmentCorpus, validateDevelopmentResults,
  type DevelopmentCorpus, type DevelopmentResultRow,
} from "./routerDevelopmentBenchmark";
import { validateDevelopmentPlan, type DevelopmentPlan, type DevelopmentSource } from "./routerDevelopmentBenchmarkPlan";
import { validateCollectionManifest, type CollectionManifest } from "./routerDevelopmentCollector";

export const DEVELOPMENT_REPLAY_VERSION = "router-development-replay-v1";
export const DEVELOPMENT_REPLAY_POLICY_VERSION = "router-development-replay-policy-v1";
export type ReplayPolicy = {
  schemaVersion: typeof DEVELOPMENT_REPLAY_POLICY_VERSION;
  purpose: "development-only";
  policyId: string;
  preferences: Partial<Record<TaskKind, string[]>>;
  fallback: "original-router";
};

export function validateReplayPolicy(value: unknown, modelIds: readonly string[]): ReplayPolicy {
  canonicalBenchmarkJson(value);
  const policy = strictBenchmarkObject(value, ["schemaVersion", "purpose", "policyId", "preferences", "fallback"], "replay_policy");
  if (policy.schemaVersion !== DEVELOPMENT_REPLAY_POLICY_VERSION || policy.purpose !== "development-only" || policy.fallback !== "original-router") throw new Error("replay_policy_version_or_scope");
  if (typeof policy.policyId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(policy.policyId)) throw new Error("replay_policy_id");
  const preferences = policy.preferences;
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) throw new Error("replay_policy_preferences");
  for (const [kind, ids] of Object.entries(preferences)) {
    if (!(TASK_KINDS as readonly string[]).includes(kind) || !Array.isArray(ids) || ids.length === 0 || ids.length > modelIds.length || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== "string" || !modelIds.includes(id))) throw new Error("replay_policy_preference_invalid");
  }
  return value as ReplayPolicy;
}

/** This boundary receives no case identity, expected answer, answer text or grader. */
export function selectReplayCandidate(input: {
  profile: TaskProfile;
  eligible: readonly RouterCandidate[];
  baselineModelId: string | null;
  policy: ReplayPolicy;
}): { modelId: string | null; reason: "task_kind_preference" | "original_router_fallback" } {
  const preferred = input.policy.preferences[input.profile.kind]?.find((modelId) => input.eligible.some((candidate) => candidate.modelId === modelId));
  return preferred ? { modelId: preferred, reason: "task_kind_preference" } : { modelId: input.baselineModelId, reason: "original_router_fallback" };
}

type PlannedRow = DevelopmentPlan["rows"][number];
export function replayGenerationContract(row: PlannedRow, settings: CollectionManifest["calls"][number]["settings"]) {
  return {
    promptDigest: row.promptDigest, modelId: row.modelId, provider: row.provider, apiModel: row.apiModel,
    callConfigDigest: row.callConfigDigest, maxOutputTokens: row.callConfig.proposedMaxOutputTokens,
    settings, search: false, attachments: false, tools: false, maxRetries: 0,
  };
}
type GenerationContract = ReturnType<typeof replayGenerationContract>;
export function replayContractMismatches(expected: GenerationContract, observed: GenerationContract): string[] {
  return (Object.keys(expected) as (keyof GenerationContract)[]).filter((key) => canonicalBenchmarkJson(expected[key]) !== canonicalBenchmarkJson(observed[key]));
}

type ObservedOutcome = "correct" | "incorrect" | "blank" | "invalid_json" | "failed" | "timeout";
type ReplayChoice = {
  modelId: string | null;
  rowId: string | null;
  reason: string;
  available: boolean;
  unavailableReason: "no_router_candidate" | "benchmark_refused" | "not_selected_for_collection" | "not_observed" | "generation_contract_mismatch" | null;
  contractDigest: string | null;
  outcome: ObservedOutcome | null;
  failureCode: string | null;
  historicalMetrics: DevelopmentResultRow["metrics"] | null;
};

function summarizeChoices(choices: readonly ReplayChoice[]) {
  const available = choices.filter((choice) => choice.available);
  const count = (outcome: ObservedOutcome) => available.filter((choice) => choice.outcome === outcome).length;
  const metric = (field: "providerCostUsd" | "latencyMs") => {
    const values = available.flatMap((choice) => choice.historicalMetrics?.[field] == null ? [] : [choice.historicalMetrics[field]!]);
    const total = values.length > 0 && values.length === available.length ? values.reduce((sum, value) => sum + value, 0) : null;
    return { observedCases: values.length, availableCases: available.length, total, mean: total === null ? null : total / values.length };
  };
  return {
    populationCases: choices.length, selectedCases: choices.filter((choice) => choice.modelId !== null).length,
    availableCases: available.length, unavailableCases: choices.length - available.length,
    correct: count("correct"), incorrect: count("incorrect"), blank: count("blank"), invalidJson: count("invalid_json"),
    failed: count("failed"), timeout: count("timeout"),
    coverage: choices.length ? available.length / choices.length : null,
    wholePopulationCorrectOutcomeShare: choices.length > 0 && available.length === choices.length ? count("correct") / choices.length : null,
    reportedProviderCostUsd: metric("providerCostUsd"), historicalWholeCallLatencyMs: metric("latencyMs"),
  };
}

export function summarizeReplayPairs(rows: readonly { baseline: ReplayChoice; candidate: ReplayChoice }[]) {
  const pairs = rows.filter((row) => row.baseline.available && row.candidate.available);
  const acquired = (choice: ReplayChoice) => choice.outcome === "failed" || choice.outcome === "timeout";
  const answered = pairs.filter((pair) => !acquired(pair.baseline) && !acquired(pair.candidate));
  const count = (predicate: (pair: typeof pairs[number]) => boolean) => pairs.filter(predicate).length;
  const baselineCorrect = count((pair) => pair.baseline.outcome === "correct");
  const candidateCorrect = count((pair) => pair.candidate.outcome === "correct");
  const delta = pairs.length ? (candidateCorrect - baselineCorrect) / pairs.length : null;
  return {
    populationCases: rows.length, commonObservedCases: pairs.length, unavailablePairCases: rows.length - pairs.length,
    changedSelectionCases: rows.filter((row) => row.baseline.modelId !== row.candidate.modelId).length,
    changedSelectionObservedCases: count((pair) => pair.baseline.modelId !== pair.candidate.modelId),
    sameSelectionObservedCases: count((pair) => pair.baseline.modelId === pair.candidate.modelId),
    bothAnsweredCases: answered.length,
    correctedCases: answered.filter((pair) => pair.baseline.outcome !== "correct" && pair.candidate.outcome === "correct").length,
    regressedCases: answered.filter((pair) => pair.baseline.outcome === "correct" && pair.candidate.outcome !== "correct").length,
    unchangedOutcomeCases: count((pair) => pair.baseline.outcome === pair.candidate.outcome),
    acquisitionFailureCases: count((pair) => acquired(pair.baseline) || acquired(pair.candidate)),
    recoveredAcquisitionFailureCases: count((pair) => acquired(pair.baseline) && !acquired(pair.candidate)),
    introducedAcquisitionFailureCases: count((pair) => !acquired(pair.baseline) && acquired(pair.candidate)),
    baselineCorrect, candidateCorrect,
    observedSubset: {
      basis: "descriptive_common_observed_benchmark_calls_including_acquisition_failures",
      denominator: pairs.length,
      baselineCorrectOutcomeShare: pairs.length ? baselineCorrect / pairs.length : null,
      candidateCorrectOutcomeShare: pairs.length ? candidateCorrect / pairs.length : null,
      correctOutcomeShareDelta: delta,
    },
    wholePopulationCorrectOutcomeShareDelta: pairs.length === rows.length && rows.length > 0 ? delta : null,
  };
}

function productCompatibility(row: PlannedRow | undefined, profile: TaskProfile) {
  const reasons: string[] = [];
  if (!row) reasons.push("no_router_candidate");
  else {
    if (!row.router.eligible) reasons.push("original_router_ineligible");
    if (!row.benchmarkEligibility.eligible) reasons.push("benchmark_refused");
    if (row.router.originalFittedOutputTokens !== row.callConfig.proposedMaxOutputTokens) reasons.push("original_router_output_cap_differs");
    if (profile.needsCurrentInformation) reasons.push("original_profile_search_not_collected");
    if (profile.hasImageInput || profile.hasDocumentInput) reasons.push("original_profile_attachments_not_collected");
  }
  return {
    modelId: row?.modelId ?? null,
    comparedFieldsCompatible: reasons.length === 0, reasons,
    originalRouterFittedOutputTokens: row?.router.originalFittedOutputTokens ?? null,
    benchmarkMaxOutputTokens: row?.callConfig.proposedMaxOutputTokens ?? null,
    originalProfileNeedsSearch: profile.needsCurrentInformation, benchmarkSearch: false,
    productExecutionVerified: false,
  };
}

export function replayDevelopment(input: {
  corpus: DevelopmentCorpus;
  models: readonly AiModel[];
  manifest: unknown;
  answers: unknown;
  candidate: unknown;
  observationSource: { benchmark: DevelopmentSource; collector: DevelopmentSource; corpusFileDigest: string };
  replaySource: DevelopmentSource;
}) {
  const corpus = validateDevelopmentCorpus(input.corpus);
  const wrapper = strictBenchmarkObject(input.manifest, ["schemaVersion", "purpose", "status", "plan", "collectorSource", "selectedRowIds", "calls", "limits", "assumptions", "totalReservedMicroUsd", "completionPossibleWithinLimits", "manifestDigest"], "replay_manifest");
  if (input.observationSource.benchmark.dirty || input.observationSource.collector.dirty || input.observationSource.benchmark.commit !== input.observationSource.collector.commit) throw new Error("replay_observation_source_invalid");
  const plan = validateDevelopmentPlan(wrapper.plan, { corpus, models: input.models, source: input.observationSource.benchmark });
  const manifest = validateCollectionManifest(input.manifest, { plan, models: input.models, collectorSource: input.observationSource.collector });
  const answers = validateDevelopmentResults(input.answers, plan);
  if (answers.rows.some((row) => !manifest.selectedRowIds.includes(row.rowId))) throw new Error("replay_answer_outside_manifest_selection");
  const policy = validateReplayPolicy(input.candidate, input.models.map((model) => model.id));
  const observedByRow = new Map(answers.rows.map((row) => [row.rowId, row]));
  const callsByRow = new Map(manifest.calls.map((call) => [call.rowId, call]));
  const caseRows = corpus.cases.map((item) => {
    const plannedRows = plan.rows.filter((row) => row.caseId === item.id);
    const first = plannedRows[0];
    const profile = buildTaskProfile({ text: item.prompt });
    const admission = filterRouterCandidates({
      models: input.models, profile, plan: plan.inputs.plan, searchBackendReadiness: NO_WEB_SEARCH_BACKENDS,
      reservedInputTokens: first.router.originalReservedInputTokens,
      requestOutputCapTokens: first.router.originalRequestOutputCapTokens,
    });
    const baseline: RouterSelectionResult = selectRouterModel({
      profile, eligible: admission.eligible, sticky: null,
      signals: { expectedTotalCostUsdByModelId: expectedTotalCostUsdByModel({
        models: input.models, reservedInputTokens: first.router.originalReservedInputTokens,
        requestOutputCapTokens: first.router.originalRequestOutputCapTokens,
      }) },
    });
    const frozenPrimary = plannedRows.filter((row) => row.router.selected);
    if (frozenPrimary.length > 1 || (frozenPrimary[0]?.modelId ?? null) !== baseline.selectedModelId || plannedRows.some((row) => row.router.eligible !== admission.eligible.some((candidate) => candidate.modelId === row.modelId) || row.router.taskKind !== profile.kind || row.router.needsCurrentInformation !== profile.needsCurrentInformation)) throw new Error("replay_original_router_mismatch");
    const candidate = selectReplayCandidate({ profile, eligible: admission.eligible, baselineModelId: baseline.selectedModelId, policy });
    const observe = (modelId: string | null, reason: string): ReplayChoice => {
      const row = plannedRows.find((planned) => planned.modelId === modelId);
      const choice: ReplayChoice = { modelId, rowId: row?.rowId ?? null, reason, available: false, unavailableReason: null, contractDigest: null, outcome: null, failureCode: null, historicalMetrics: null };
      if (!row) return { ...choice, unavailableReason: "no_router_candidate" };
      if (!row.benchmarkEligibility.eligible) return { ...choice, unavailableReason: "benchmark_refused" };
      const call = callsByRow.get(row.rowId);
      if (!call) return { ...choice, unavailableReason: "not_selected_for_collection" };
      const model = input.models.find((entry) => entry.id === modelId)!;
      const expected = replayGenerationContract(row, getModelGenerationSettings(model));
      const contract = replayGenerationContract(row, call.settings);
      if (call.reserve.outputCapTokens !== expected.maxOutputTokens || replayContractMismatches(expected, contract).length) return { ...choice, unavailableReason: "generation_contract_mismatch" };
      choice.contractDigest = benchmarkDigest(canonicalBenchmarkJson(contract));
      const observed = observedByRow.get(row.rowId);
      if (!observed) return { ...choice, unavailableReason: "not_observed" };
      let outcome: ObservedOutcome;
      if (observed.status !== "succeeded") outcome = observed.status;
      else {
        const verdict = gradeDevelopmentAnswer(item, observed.answerText!);
        outcome = verdict.reason === "exact_match" ? "correct" : verdict.reason === "value_mismatch" ? "incorrect" : verdict.reason === "blank_answer" ? "blank" : "invalid_json";
      }
      return { ...choice, available: true, outcome, failureCode: observed.failureCode, historicalMetrics: observed.metrics };
    };
    return {
      caseId: item.id, taskKind: profile.kind, profileSignals: profile.signals,
      baseline: observe(baseline.selectedModelId, baseline.reason), candidate: observe(candidate.modelId, candidate.reason),
      productCompatibility: {
        baseline: productCompatibility(plannedRows.find((row) => row.modelId === baseline.selectedModelId), profile),
        candidate: productCompatibility(plannedRows.find((row) => row.modelId === candidate.modelId), profile),
      },
    };
  });
  const originalScore = scoreDevelopmentResults(corpus, plan, answers);
  return {
    schemaVersion: DEVELOPMENT_REPLAY_VERSION, purpose: "development-only",
    evidenceStatus: answers.origin.kind === "synthetic-fixture" ? "fixture_validation_only" : "self_reported_saved_answers_unverified",
    providerCallsByThisTool: 0, incurredProviderSpendUsdByThisTool: 0,
    observationSource: { ...input.observationSource, manifestDigest: manifest.manifestDigest, planDigest: plan.planDigest, corpusDigest: plan.corpusDigest, answersDigest: benchmarkDigest(canonicalBenchmarkJson(answers)) },
    replaySource: input.replaySource,
    candidate: { ...policy, policyDigest: benchmarkDigest(canonicalBenchmarkJson(policy)) },
    observationBundle: {
      catalogueModels: plan.models.length, catalogueRows: plan.rows.length,
      manifestSelectedRows: manifest.selectedRowIds.length, importedRows: answers.rows.length,
      originalScoreSummary: originalScore.summary,
      catalogueCoverage: originalScore.byModel.map((summary) => {
        const model = plan.models.find((entry) => entry.modelId === summary.modelId)!;
        return { ...summary, provider: model.provider, apiModel: model.apiModel };
      }),
    },
    benchmarkDomain: {
      basis: "original_static_router_selection_under_fixed_per_model_benchmark_generation_contracts",
      baseline: summarizeChoices(caseRows.map((row) => row.baseline)),
      candidate: summarizeChoices(caseRows.map((row) => row.candidate)),
      paired: summarizeReplayPairs(caseRows),
      rows: caseRows.map((row) => ({ caseId: row.caseId, taskKind: row.taskKind, profileSignals: row.profileSignals, baseline: row.baseline, candidate: row.candidate })),
    },
    productCompatibility: {
      basis: "original_router_cap_and_profile_requirements_compared_with_benchmark_calls_only",
      productPerformanceDelta: null, productExecutionVerified: false,
      populationCases: caseRows.length,
      baselineCompatibleCases: caseRows.filter((row) => row.productCompatibility.baseline.comparedFieldsCompatible).length,
      candidateCompatibleCases: caseRows.filter((row) => row.productCompatibility.candidate.comparedFieldsCompatible).length,
      commonObservedCases: caseRows.filter((row) => row.baseline.available && row.candidate.available).length,
      baselineObservedCompatibleCases: caseRows.filter((row) => row.baseline.available && row.productCompatibility.baseline.comparedFieldsCompatible).length,
      candidateObservedCompatibleCases: caseRows.filter((row) => row.candidate.available && row.productCompatibility.candidate.comparedFieldsCompatible).length,
      commonObservedCompatibleCases: caseRows.filter((row) => row.baseline.available && row.candidate.available && row.productCompatibility.baseline.comparedFieldsCompatible && row.productCompatibility.candidate.comparedFieldsCompatible).length,
      rows: caseRows.map((row) => ({ caseId: row.caseId, ...row.productCompatibility })),
    },
    limitations: [
      "Synthetic development cases and exploratory policy control; no policy adoption, confidence interval, ROUTE-01 or production-quality verdict.",
      "Selection policies share original Router hard eligibility; benchmark observations use separately frozen per-model output caps and collector settings.",
      "Common observed subset statistics include acquisition failures in their denominator; missing observations are unavailable, never losses. Whole-population delta requires complete paired coverage.",
      "Compared product fields are a diagnostic only: prompts, wrappers, runtime registry, health, account access and complete dispatch execution are not verified.",
      "Saved provider cost remains nullable and unverified. Latency is a historical whole-call measurement, not TTFT, a forecast or a fresh policy execution.",
      "Hashes bind imported records and independently selected source bytes; they do not authenticate provider responses or invoices.",
    ],
  };
}
