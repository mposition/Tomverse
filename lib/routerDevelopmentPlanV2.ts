/** Explicit v2 planning. No provider construction, gold projection or spending authority. */
import {
  benchmarkDigest, canonicalBenchmarkJson, strictBenchmarkObject,
} from "./routerDevelopmentBenchmark";
import {
  CORPUS_V2_VERSION, PARTITIONS_V2_VERSION, validateDevelopmentCorpusV2,
  validateDevelopmentPartitionsV2, type DevelopmentCorpusV2, type DevelopmentPartitionsV2,
} from "./routerDevelopmentCorpusV2";
import { buildDevelopmentMatrix, type DevelopmentMatrixInput } from "./routerDevelopmentBenchmarkPlan";

export const DEVELOPMENT_PLAN_V2_VERSION = "router-development-plan-v2";
export type DevelopmentPlanInputV2 = Omit<DevelopmentMatrixInput, "corpus"> & {
  corpus: DevelopmentCorpusV2; partitions: DevelopmentPartitionsV2;
};
const digest = (value: unknown) => benchmarkDigest(canonicalBenchmarkJson(value));

export function buildDevelopmentPlanV2(input: DevelopmentPlanInputV2) {
  const corpus = validateDevelopmentCorpusV2(input.corpus);
  const partitions = validateDevelopmentPartitionsV2(input.partitions, corpus);
  const matrix = buildDevelopmentMatrix({ ...input, corpus });
  const cases = new Map(corpus.cases.map((item) => [item.id, item]));
  const familyPartitions = new Map(partitions.families.map((item) => [item.familyId, item.partition]));
  const metadata = (caseId: string) => {
    const item = cases.get(caseId)!;
    return { difficulty: item.difficulty, familyId: item.familyId, partition: familyPartitions.get(item.familyId)! };
  };
  const body = {
    schemaVersion: DEVELOPMENT_PLAN_V2_VERSION as typeof DEVELOPMENT_PLAN_V2_VERSION, ...matrix,
    partitionId: partitions.partitionId, partitionDigest: digest(partitions),
    versions: { ...matrix.versions, corpus: CORPUS_V2_VERSION, partitions: PARTITIONS_V2_VERSION },
    rows: matrix.rows.map((row) => ({ ...row, ...metadata(row.caseId) })),
    byCase: matrix.byCase.map((row) => ({ ...row, ...metadata(row.caseId) })),
    limitations: [
      ...matrix.limitations.filter((line) => !line.startsWith("Search, attachments")),
      "Search, attachments and tools are unsupported in v2; intrinsic search models are retained as refused rows.",
      "Difficulty and whole-family development partitions are engineering labels, not measured difficulty or independent decision samples.",
      "All 48 cases and all catalogue rows are retained; selected mock calls are a separate bounded subset.",
      "V2 observations in this bridge are mock-only. No live collector authorization or historical answer import is supplied.",
    ],
  };
  return { ...body, planDigest: digest(body) };
}

export type DevelopmentPlanV2 = ReturnType<typeof buildDevelopmentPlanV2>;
export function validateDevelopmentPlanV2(
  value: unknown,
  input: Omit<DevelopmentPlanInputV2, "createdAt" | "plan" | "requestedModelId">,
): DevelopmentPlanV2 {
  canonicalBenchmarkJson(value);
  const saved = strictBenchmarkObject(value, [
    "schemaVersion", "purpose", "corpusId", "corpusDigest", "createdAt", "source", "catalogueDigest",
    "versions", "inputs", "models", "rows", "byCase", "summary", "limitations", "partitionId", "partitionDigest", "planDigest",
  ], "plan_v2");
  if (saved.schemaVersion !== DEVELOPMENT_PLAN_V2_VERSION || saved.purpose !== "development-only") throw new Error("plan_v2_version_or_purpose");
  if (canonicalBenchmarkJson(saved.source) !== canonicalBenchmarkJson(input.source)) throw new Error("plan_v2_source_snapshot_mismatch");
  const options = strictBenchmarkObject(saved.inputs, ["plan", "requestedModelId", "catalogueSource", "searchBackendReadiness", "credits", "health", "region", "stickyState"], "plan_v2.inputs");
  if (typeof saved.createdAt !== "string" || typeof options.requestedModelId !== "string") throw new Error("plan_v2_input_invalid");
  const expected = buildDevelopmentPlanV2({ ...input, createdAt: saved.createdAt, plan: options.plan as DevelopmentPlanInputV2["plan"], requestedModelId: options.requestedModelId });
  if (canonicalBenchmarkJson(saved) !== canonicalBenchmarkJson(expected)) throw new Error("plan_v2_snapshot_mismatch");
  return expected;
}
