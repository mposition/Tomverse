/** Mock-only v2 results. Versioned envelopes never masquerade as legacy results. */
import {
  DEVELOPMENT_GRADER_VERSION, benchmarkDigest, benchmarkString, canonicalBenchmarkJson,
  strictBenchmarkObject, validateDevelopmentResultRows, type DevelopmentResultRow,
} from "./routerDevelopmentBenchmark";
import {
  CORPUS_V2_FAMILIES, gradeDevelopmentV2Answer, validateDevelopmentCorpusV2,
  validateDevelopmentPartitionsV2, type DevelopmentCorpusV2, type DevelopmentPartitionsV2,
} from "./routerDevelopmentCorpusV2";
import { DEVELOPMENT_PLAN_V2_VERSION, type DevelopmentPlanV2 } from "./routerDevelopmentPlanV2";

export const DEVELOPMENT_RESULTS_V2_VERSION = "router-development-results-v2";
export const DEVELOPMENT_SCORE_V2_VERSION = "router-development-score-v2";
export type DevelopmentResultsV2 = {
  schemaVersion: typeof DEVELOPMENT_RESULTS_V2_VERSION; purpose: "development-only";
  corpusDigest: string; partitionDigest: string; planDigest: string;
  origin: { kind: "synthetic-fixture"; description: string }; rows: DevelopmentResultRow[];
};
const digest = (value: unknown) => benchmarkDigest(canonicalBenchmarkJson(value));
function requirePlanDigest(plan: DevelopmentPlanV2) {
  if (plan.schemaVersion !== DEVELOPMENT_PLAN_V2_VERSION || plan.purpose !== "development-only") throw new Error("results_v2_plan_version_or_purpose");
  const { planDigest, ...body } = plan;
  if (planDigest !== digest(body)) throw new Error("results_v2_plan_digest_mismatch");
}

/** Callers reconstruct the plan against trusted models/source before importing results. */
export function validateDevelopmentResultsV2(value: unknown, plan: DevelopmentPlanV2): DevelopmentResultsV2 {
  requirePlanDigest(plan);
  canonicalBenchmarkJson(value);
  const saved = strictBenchmarkObject(value, ["schemaVersion", "purpose", "corpusDigest", "partitionDigest", "planDigest", "origin", "rows"], "results_v2");
  if (saved.schemaVersion !== DEVELOPMENT_RESULTS_V2_VERSION || saved.purpose !== "development-only") throw new Error("results_v2_version_or_purpose");
  if (saved.corpusDigest !== plan.corpusDigest || saved.partitionDigest !== plan.partitionDigest || saved.planDigest !== plan.planDigest) throw new Error("results_v2_digest_mismatch");
  const origin = strictBenchmarkObject(saved.origin, ["kind", "description"], "results_v2.origin");
  if (origin.kind !== "synthetic-fixture") throw new Error("results_v2_mock_only");
  benchmarkString(origin.description, "results_v2.origin.description");
  validateDevelopmentResultRows(saved.rows, plan, origin.kind);
  return value as DevelopmentResultsV2;
}

/** Revalidate corpus/partition binding and retain every matrix denominator. */
export function scoreDevelopmentResultsV2(
  corpusInput: DevelopmentCorpusV2, partitionInput: DevelopmentPartitionsV2,
  plan: DevelopmentPlanV2, value: unknown,
) {
  const corpus = validateDevelopmentCorpusV2(corpusInput);
  const partitions = validateDevelopmentPartitionsV2(partitionInput, corpus);
  if (digest(corpus) !== plan.corpusDigest || digest(partitions) !== plan.partitionDigest) throw new Error("score_v2_corpus_or_partition_digest_mismatch");
  const results = validateDevelopmentResultsV2(value, plan);
  const cases = new Map(corpus.cases.map((item) => [item.id, item]));
  const partitionByFamily = new Map(partitions.families.map((item) => [item.familyId, item.partition]));
  const modelIds = new Set(plan.models.map((model) => model.modelId));
  const identities = new Set<string>();
  if (!modelIds.size || modelIds.size !== plan.models.length || plan.rows.length !== corpus.cases.length * modelIds.size) throw new Error("score_v2_matrix_coverage");
  for (const row of plan.rows) {
    const item = cases.get(row.caseId);
    if (!item || !modelIds.has(row.modelId) || row.rowId !== `${row.caseId}::${row.modelId}` || identities.has(row.rowId)
      || row.language !== item.language || row.task !== item.task || row.difficulty !== item.difficulty
      || row.familyId !== item.familyId || row.partition !== partitionByFamily.get(item.familyId)
      || canonicalBenchmarkJson(row.input) !== canonicalBenchmarkJson({ prompt: item.prompt })
      || row.promptDigest !== benchmarkDigest(item.prompt)) throw new Error("score_v2_matrix_identity");
    identities.add(row.rowId);
  }
  const savedById = new Map(results.rows.map((row) => [row.rowId, row]));
  const rows = plan.rows.map((planned) => {
    const saved = savedById.get(planned.rowId);
    const verdict = saved?.status === "succeeded" ? gradeDevelopmentV2Answer(cases.get(planned.caseId)!, saved.answerText!) : null;
    const outcome = !planned.benchmarkEligibility.eligible ? "refused" : !saved ? "not_run" : saved.status !== "succeeded" ? saved.status : verdict!.reason;
    return {
      rowId: planned.rowId, caseId: planned.caseId, modelId: planned.modelId,
      language: planned.language, task: planned.task, difficulty: planned.difficulty,
      familyId: planned.familyId, partition: planned.partition, outcome, pass: verdict?.pass ?? false,
    };
  });
  const summarize = (group: typeof rows) => {
    const planned = group.filter((row) => row.outcome !== "refused");
    const submitted = planned.filter((row) => row.outcome !== "not_run");
    const passed = submitted.filter((row) => row.pass).length;
    return {
      catalogueRows: group.length, planned: planned.length, refused: group.length - planned.length,
      submitted: submitted.length, notRun: planned.length - submitted.length, passed,
      returnedAnswerRecords: submitted.filter((row) => !["failed", "timeout"].includes(row.outcome)).length,
      incorrect: submitted.filter((row) => row.outcome === "value_mismatch").length,
      blank: submitted.filter((row) => row.outcome === "blank_answer").length,
      invalidJson: submitted.filter((row) => row.outcome === "invalid_json").length,
      failed: submitted.filter((row) => row.outcome === "failed").length,
      timeout: submitted.filter((row) => row.outcome === "timeout").length,
      coverage: planned.length ? submitted.length / planned.length : null,
      correctnessRate: planned.length > 0 && submitted.length === planned.length ? passed / planned.length : null,
      correctShareOfPlanned: submitted.length > 0 && planned.length > 0 ? passed / planned.length : null,
    };
  };
  const cells = Object.keys(CORPUS_V2_FAMILIES).flatMap((task) => ["ko", "en"].flatMap((language) => ["basic", "advanced"].map((difficulty) => ({ task, language, difficulty }))));
  const cellRows = (cell: typeof cells[number], group = rows) => group.filter((row) => row.task === cell.task && row.language === cell.language && row.difficulty === cell.difficulty);
  const partitionNames = ["tuning", "development-validation"] as const;
  const familyIds = partitions.families.map((item) => item.familyId);
  const score = {
    schemaVersion: DEVELOPMENT_SCORE_V2_VERSION as typeof DEVELOPMENT_SCORE_V2_VERSION, purpose: "development-only" as const, graderVersion: DEVELOPMENT_GRADER_VERSION,
    corpusDigest: plan.corpusDigest, partitionDigest: plan.partitionDigest, planDigest: plan.planDigest,
    resultsDigest: digest(results), origin: results.origin, evidenceStatus: "fixture_validation_only",
    decisionEvidence: false, modelQualityMeasured: false,
    providerCallsByThisTool: 0, incurredProviderSpendUsdByThisTool: 0, verifiedActualGenerations: 0,
    summary: summarize(rows),
    byCell: cells.map((cell) => ({ ...cell, ...summarize(cellRows(cell)) })),
    byPartition: partitionNames.map((partition) => ({ partition, ...summarize(rows.filter((row) => row.partition === partition)) })),
    byFamily: familyIds.map((familyId) => ({ familyId, partition: partitionByFamily.get(familyId)!, ...summarize(rows.filter((row) => row.familyId === familyId)) })),
    byModel: plan.models.map(({ modelId }) => ({ modelId, ...summarize(rows.filter((row) => row.modelId === modelId)) })),
    byModelTaskLanguageDifficulty: plan.models.flatMap(({ modelId }) => cells.map((cell) => ({ modelId, ...cell, ...summarize(cellRows(cell, rows.filter((row) => row.modelId === modelId))) }))),
    byModelPartition: plan.models.flatMap(({ modelId }) => partitionNames.map((partition) => ({ modelId, partition, ...summarize(rows.filter((row) => row.modelId === modelId && row.partition === partition)) }))),
    byModelFamily: plan.models.flatMap(({ modelId }) => familyIds.map((familyId) => ({ modelId, familyId, ...summarize(rows.filter((row) => row.modelId === modelId && row.familyId === familyId)) }))),
    reportedMetrics: Object.fromEntries(["inputTokens", "outputTokens", "latencyMs", "providerCostUsd"].map((key) => [key, { observedRows: 0, submittedRows: results.rows.length, total: null }])),
    rows,
    limitations: [
      "Mock-only fixture validation. No provider observations, measured model quality, confidence intervals, policy winner, or release verdict.",
      "All catalogue rows and all eight cells remain in coverage. Missing eligible rows are not_run, not failures or exclusions.",
      "Headline correctness is null for incomplete planned coverage; completed fixture answers do not establish model quality.",
      "Difficulty and whole-family development partitions are engineering labels, not independent decision samples.",
      "The importing bridge must reconstruct the plan from trusted source bytes, corpus, partitions and catalogue before scoring.",
    ],
  };
  canonicalBenchmarkJson(score);
  return score;
}
