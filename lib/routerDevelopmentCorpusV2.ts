/** Bounded development corpus only; not a plan, provider runner or release gate. */
import {
  DEVELOPMENT_LIMITS, benchmarkDigest, benchmarkString, canonicalBenchmarkJson,
  gradeDevelopmentAnswer, isBenchmarkDigest, modelInputForCase, parseBenchmarkJson,
  strictBenchmarkObject, type DevelopmentCase,
} from "./routerDevelopmentBenchmark";

export const CORPUS_V2_VERSION = "router-development-corpus-v2";
export const PARTITIONS_V2_VERSION = "router-development-partitions-v2";
export const PROMPT_PACKET_V2_VERSION = "router-development-prompt-packet-v2";
export const CORPUS_V2_LIMITS = { corpusBytes: DEVELOPMENT_LIMITS.corpusBytes, partitionBytes: 16_384, cases: 48 } as const;
export const CORPUS_V2_FAMILIES = {
  "structured-extraction": ["extract-active-selection", "extract-revision-resolution", "extract-keyed-join", "extract-state-fold", "extract-ordered-membership", "extract-literal-projection"],
  "grounded-calculation": ["calc-inventory-ledger", "calc-invoice-adjustments", "calc-unit-conversion", "calc-elapsed-windows", "calc-weighted-capacity", "calc-tiered-allocation"],
} as const;
export type CorpusV2Case = DevelopmentCase & { difficulty: "basic" | "advanced"; familyId: string };
export type DevelopmentCorpusV2 = {
  schemaVersion: typeof CORPUS_V2_VERSION; corpusId: "tomverse-router-development-v2";
  purpose: "development-only"; cases: CorpusV2Case[];
};
export type CorpusV2Partition = "tuning" | "development-validation";
export type DevelopmentPartitionsV2 = {
  schemaVersion: typeof PARTITIONS_V2_VERSION; partitionId: "tomverse-router-development-v2-family-split-v1";
  purpose: "development-only"; corpusDigest: string;
  families: { familyId: string; partition: CorpusV2Partition }[];
};
function fail(code: string): never { throw new Error(`corpus_v2_${code}`); }
const digest = (value: unknown) => benchmarkDigest(canonicalBenchmarkJson(value));

export function validateDevelopmentCorpusV2(value: unknown): DevelopmentCorpusV2 {
  if (Buffer.byteLength(canonicalBenchmarkJson(value)) > CORPUS_V2_LIMITS.corpusBytes) fail("byte_limit");
  const corpus = strictBenchmarkObject(value, ["schemaVersion", "corpusId", "purpose", "cases"], "corpus_v2");
  if (corpus.schemaVersion !== CORPUS_V2_VERSION || corpus.corpusId !== "tomverse-router-development-v2" || corpus.purpose !== "development-only") fail("version_or_purpose");
  if (!Array.isArray(corpus.cases) || corpus.cases.length !== CORPUS_V2_LIMITS.cases) fail("requires_48_cases");
  const ids = new Set<string>();
  const prompts = new Set<string>();
  const cells = new Map<string, number>();
  const familyCells = new Set<string>();
  for (const raw of corpus.cases) {
    const item = strictBenchmarkObject(raw, ["id", "language", "task", "difficulty", "familyId", "prompt", "expected", "grading", "requirements"], "corpus_v2_case");
    const id = benchmarkString(item.id, "corpus_v2_case.id", 100);
    const match = /^v2-(en|ko)-(extract|calc)-(basic|advanced)-(0[1-6])$/.exec(id);
    if (!match || ids.has(id)) fail("id_or_duplicate");
    ids.add(id);
    const task = match[2] === "extract" ? "structured-extraction" : "grounded-calculation";
    if (item.language !== match[1] || item.task !== task || item.difficulty !== match[3]) fail("id_cell_mismatch");
    if (item.familyId !== CORPUS_V2_FAMILIES[task][Number(match[4]) - 1]) fail("family_id_mismatch");
    const familyCell = `${item.familyId}:${item.language}:${item.difficulty}`;
    if (familyCells.has(familyCell)) fail("duplicate_family_cell");
    familyCells.add(familyCell);
    const prompt = benchmarkString(item.prompt, "corpus_v2_case.prompt", DEVELOPMENT_LIMITS.promptBytes);
    if (prompts.has(prompt)) fail("duplicate_prompt");
    prompts.add(prompt);
    const pieces = prompt.split("\nSOURCE_JSON\n");
    if (pieces.length !== 2) fail("source_block");
    const source = pieces[1].split("\nEND_SOURCE_JSON\n");
    if (source.length !== 2 || !pieces[0].trim() || !source[1].trim()) fail("source_block");
    const data = parseBenchmarkJson(source[0], DEVELOPMENT_LIMITS.promptBytes);
    if (!data || typeof data !== "object" || Array.isArray(data)) fail("source_object");
    if (!item.expected || typeof item.expected !== "object" || Array.isArray(item.expected) || Object.keys(item.expected).length === 0) fail("expected_object");
    const grading = strictBenchmarkObject(item.grading, ["kind", "arrayOrder", "stringNormalization"], "corpus_v2_grading");
    if (grading.kind !== "exact-json" || grading.arrayOrder !== "ordered" || grading.stringNormalization !== "none") fail("grading");
    const requirements = strictBenchmarkObject(item.requirements, ["needsSearch", "attachments", "tools"], "corpus_v2_requirements");
    if (requirements.needsSearch !== false || !Array.isArray(requirements.attachments) || requirements.attachments.length || !Array.isArray(requirements.tools) || requirements.tools.length) fail("unsupported_mode");
    const cell = `${task}:${item.language}:${item.difficulty}`;
    cells.set(cell, (cells.get(cell) ?? 0) + 1);
  }
  if (cells.size !== 8 || [...cells.values()].some((count) => count !== 6) || familyCells.size !== 48) fail("cell_coverage");
  return value as DevelopmentCorpusV2;
}

export const parseDevelopmentCorpusV2 = (text: string): DevelopmentCorpusV2 =>
  validateDevelopmentCorpusV2(parseBenchmarkJson(text, CORPUS_V2_LIMITS.corpusBytes));

export function validateDevelopmentPartitionsV2(value: unknown, input: DevelopmentCorpusV2): DevelopmentPartitionsV2 {
  const corpus = validateDevelopmentCorpusV2(input);
  if (Buffer.byteLength(canonicalBenchmarkJson(value)) > CORPUS_V2_LIMITS.partitionBytes) fail("partition_byte_limit");
  const manifest = strictBenchmarkObject(value, ["schemaVersion", "partitionId", "purpose", "corpusDigest", "families"], "corpus_v2_partitions");
  if (manifest.schemaVersion !== PARTITIONS_V2_VERSION || manifest.partitionId !== "tomverse-router-development-v2-family-split-v1" || manifest.purpose !== "development-only") fail("partition_version_or_purpose");
  if (!isBenchmarkDigest(manifest.corpusDigest) || manifest.corpusDigest !== digest(corpus)) fail("partition_corpus_digest");
  if (!Array.isArray(manifest.families) || manifest.families.length !== 12) fail("partition_families");
  const byFamily = new Map<string, CorpusV2Partition>();
  const known = Object.values(CORPUS_V2_FAMILIES).flat() as readonly string[];
  for (const raw of manifest.families) {
    const row = strictBenchmarkObject(raw, ["familyId", "partition"], "corpus_v2_partition_family");
    if (typeof row.familyId !== "string" || !known.includes(row.familyId) || byFamily.has(row.familyId)) fail("partition_family_identity");
    if (row.partition !== "tuning" && row.partition !== "development-validation") fail("partition_scope");
    byFamily.set(row.familyId, row.partition);
  }
  for (const families of Object.values(CORPUS_V2_FAMILIES)) {
    if (families.filter((family) => byFamily.get(family) === "tuning").length !== 3) fail("partition_task_balance");
    // This partition ID names this assignment, not every balanced rearrangement.
    if (families.some((family, index) => byFamily.get(family) !== (index < 3 ? "tuning" : "development-validation"))) fail("partition_frozen_assignment");
  }
  return value as DevelopmentPartitionsV2;
}

export const parseDevelopmentPartitionsV2 = (text: string, corpus: DevelopmentCorpusV2) =>
  validateDevelopmentPartitionsV2(parseBenchmarkJson(text, CORPUS_V2_LIMITS.partitionBytes), corpus);

/** The provider receives no identity, difficulty, partition, gold or grading metadata. */
export const modelInputForV2Case = (item: CorpusV2Case): { prompt: string } => modelInputForCase(item);
export const gradeDevelopmentV2Answer = (item: CorpusV2Case, answerText: string) => gradeDevelopmentAnswer(item, answerText);

export function promptPacketForV2Corpus(input: DevelopmentCorpusV2) {
  const corpus = validateDevelopmentCorpusV2(input);
  const body = { schemaVersion: PROMPT_PACKET_V2_VERSION, cases: [...corpus.cases].sort((a, b) => a.id < b.id ? -1 : 1).map(({ id, prompt }) => ({ id, prompt })) };
  return { ...body, packetDigest: digest(body) };
}

/** Coverage is an engineering inventory, not observed quality or sample-size approval. */
export function developmentCorpusV2Coverage(input: DevelopmentCorpusV2, partitionInput: DevelopmentPartitionsV2) {
  const corpus = validateDevelopmentCorpusV2(input);
  const partitions = validateDevelopmentPartitionsV2(partitionInput, corpus);
  const byFamily = new Map(partitions.families.map((row) => [row.familyId, row.partition]));
  const cells = Object.keys(CORPUS_V2_FAMILIES).flatMap((task) => ["en", "ko"].flatMap((language) => ["basic", "advanced"].map((difficulty) => {
    const cases = corpus.cases.filter((item) => item.task === task && item.language === language && item.difficulty === difficulty);
    return { task, language, difficulty, cases: cases.length, tuning: cases.filter((item) => byFamily.get(item.familyId) === "tuning").length, developmentValidation: cases.filter((item) => byFamily.get(item.familyId) === "development-validation").length };
  })));
  return {
    corpusDigest: digest(corpus), partitionDigest: digest(partitions), cases: corpus.cases.length,
    familyCount: partitions.families.length, cells,
    partitions: { tuning: corpus.cases.filter((item) => byFamily.get(item.familyId) === "tuning").length, developmentValidation: corpus.cases.filter((item) => byFamily.get(item.familyId) === "development-validation").length },
    families: partitions.families.map((row) => ({ ...row, cases: corpus.cases.filter((item) => item.familyId === row.familyId).length })),
    difficultyBasis: "engineering_labels_not_measured_model_difficulty",
    partitionBasis: "whole_template_families_shared_primitives_not_independent_samples",
    decisionEvidence: false,
  };
}
