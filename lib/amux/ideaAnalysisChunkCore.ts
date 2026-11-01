import { amuxCanonicalJson } from "./boardImportCore.ts";
import { isAmuxFeatureDisplayPrefix } from "./cardDisplayKeyCore.ts";
import { scanAmuxV4Input } from "./localIntakeCore.ts";

/**
 * Structural admission for one untrusted AMUX v4 model response. This is not
 * an approval, source-provenance proof, hierarchy resolver, or DB writer.
 * The trusted caller supplies the source-ref allowlist from the confirmed
 * transfer preview; the model cannot grant itself another source.
 */
// 4 (amux-intake v17): a Feature node may propose its card number prefix.
// 5 (amux-intake v20): every Task names its expected paths, and no new
// proposal uses taskRole review.
export const AMUX_ANALYSIS_CHUNK_SCHEMA_VERSION = 5 as const;
/** amux-intake v20 item 3: repository-relative paths, 1 to 40 per Task. */
export const AMUX_TASK_EXPECTED_PATHS_MAX = 40;
export const AMUX_TASK_EXPECTED_PATH_MAX_BYTES = 512;
export const AMUX_ANALYSIS_CHUNK_MAX_BYTES = 65_536;
export const AMUX_ANALYSIS_CHUNK_CARD_CAP = 8;
export const AMUX_ANALYSIS_CHUNK_NODE_CAP = 16;
export const AMUX_ANALYSIS_CHUNK_EVIDENCE_CAP = 16;

const REF = /^[A-Za-z0-9:_-]{1,128}$/;
// The chunk prefix prevents ambiguous IDs when one project spans many chunks.
// The numeric suffix is canonical: no aliases such as card-01/card-001.
const LOCAL_ID = /^c(0|[1-9][0-9]*):(node|card|evidence)-(0|[1-9][0-9]{0,3})$/;
// Operator-confirmed text and execution briefs must not contain invisible
// instructions or direction-changing characters. Variation selectors are
// rejected even when used for emoji presentation: a retained execution brief
// cannot safely distinguish one from an invisible encoded instruction stream.
const SPOOFING_CHAR = /[\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u034F\u180B-\u180D\u180E\u180F\u17B4\u17B5\u2800\uFE00-\uFE0F\u{E0100}-\u{E01EF}]|(?![\t\n])\p{Cc}/u;
const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

export const AMUX_TASK_ROLE_PROPOSALS = [
  "design", "implement", "test", "review", "verify", "investigate", "operate",
] as const;
export const AMUX_EXECUTION_GRADE_PROPOSALS = ["routine", "advanced", "frontier"] as const;

/** Snapshot a bounded dense array without invoking a caller-supplied iterator. */
export const copyBoundedAmuxArray = <T>(value: unknown, max: number): T[] | null => {
  try {
    if (!Array.isArray(value)) return null;
    const length = value.length;
    if (!Number.isSafeInteger(length) || length > max) return null;
    const result: T[] = [];
    for (let index = 0; index < length; index += 1) {
      if (!Object.hasOwn(value, index)) return null;
      result.push(value[index] as T);
    }
    return result;
  } catch {
    return null;
  }
};

/** Trusted metadata may be read only from exact, own data properties. */
export const amuxExactDataKeys = (value: unknown, keys: readonly string[]): boolean =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  Reflect.ownKeys(value).length === keys.length && keys.every((key) =>
    "value" in (Object.getOwnPropertyDescriptor(value, key) ?? {}));

export type AmuxPermittedTargetRef =
  | { ref: string; kind: "node"; level: "initiative" | "epic" | "feature" }
  | { ref: string; kind: "card"; cardType: "story" | "task"; storyKind: "general" | "bug" | null; featureRef: string };

/** One descriptor snapshot feeds both prompt admission and model-output inspection. */
export const snapshotAmuxPermittedTarget = (value: unknown): AmuxPermittedTargetRef | null => {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const hasExact = (keys: readonly string[]) =>
      Reflect.ownKeys(descriptors).length === keys.length && keys.every((key) =>
        "value" in (descriptors[key] ?? {}));
    const kind = descriptors.kind?.value;
    if (kind === "node" && hasExact(["ref", "kind", "level"])) {
      return { ref: descriptors.ref.value, kind, level: descriptors.level.value };
    }
    if (kind === "card" && hasExact(["ref", "kind", "cardType", "storyKind", "featureRef"])) {
      return { ref: descriptors.ref.value, kind, cardType: descriptors.cardType.value,
        storyKind: descriptors.storyKind.value, featureRef: descriptors.featureRef.value };
    }
    return null;
  } catch {
    return null;
  }
};

export const amuxAnalysisRefSafe = (value: unknown): value is string =>
  typeof value === "string" && REF.test(value) && scanAmuxV4Input(value).ok;

export const amuxPermittedTargetRefSafe = (
  target: AmuxPermittedTargetRef,
  expectedChunkIndex: number,
): boolean => {
  if (!target || typeof target !== "object" || !amuxAnalysisRefSafe(target.ref) ||
      !Number.isSafeInteger(expectedChunkIndex) || expectedChunkIndex < 0) return false;
  const priorLocal = LOCAL_ID.exec(target.ref);
  if (priorLocal && (Number(priorLocal[1]) >= expectedChunkIndex || priorLocal[2] !== target.kind)) {
    return false;
  }
  if (target.kind === "node") return ["initiative", "epic", "feature"].includes(target.level);
  return target.kind === "card" && ["story", "task"].includes(target.cardType) &&
    (target.cardType === "story" ? ["general", "bug"].includes(target.storyKind as string) :
      target.storyKind === null) && amuxAnalysisRefSafe(target.featureRef);
};

export type AmuxAnalysisNode = {
  kind: "node";
  localId: string;
  level: "initiative" | "epic" | "feature";
  parentRef: string | null;
  title: string;
  description: string;
  sourceRefIds: string[];
  portfolioSignal?: AmuxPortfolioModelSignal;
  /** Feature only, chunk schema 4 (amux-intake v17): the model's card number prefix proposal. */
  displayPrefix?: string;
};

export type AmuxAnalysisCard = {
  kind: "card";
  localId: string;
  cardType: "story" | "task";
  storyKind: "general" | "bug" | null;
  title: string;
  problem: string;
  scopeIn: string[];
  scopeOut: string[];
  completionCriteria: string[];
  featureRef: string;
  parentStoryRef: string | null;
  dependencyRefs: string[];
  duplicateCandidateRefs: string[];
  taskRole: (typeof AMUX_TASK_ROLE_PROPOSALS)[number] | null;
  executionGrade: (typeof AMUX_EXECUTION_GRADE_PROPOSALS)[number] | null;
  executionBrief: string | null;
  sourceRefIds: string[];
  portfolioSignal?: AmuxPortfolioModelSignal;
  /** Task only, chunk schema 5 (amux-intake v20): the paths the Task is
   * expected to change, exactly as proposed. Normalisation and the contract
   * path split are the registration guard's, not this parser's. */
  expectedPaths?: string[];
};

/** Untrusted model suggestion; approval and score calculation happen later. */
export type AmuxPortfolioModelSignal = {
  metrics: Record<string, number>;
  uncertainty: "low" | "medium" | "high";
  rationale: string;
  evidenceRefIds: string[];
};

export type AmuxAnalysisEvidence = {
  kind: "evidence";
  localId: string;
  evidenceType: "observed_error" | "source_finding";
  summary: string;
  cardRef: string;
  sourceRefIds: string[];
};

export type AmuxAnalysisChunk = {
  schemaVersion: 2 | 3 | 4 | typeof AMUX_ANALYSIS_CHUNK_SCHEMA_VERSION;
  previewId: string;
  chunkIndex: number;
  outcome: "propose" | "needs_information" | "reject";
  coverageStatus: "complete" | "more" | "needs_owner_input";
  continuationKind: "input" | "output" | null;
  ownerQuestion: string | null;
  coveredScope: string;
  remainingScope: string | null;
  units: Array<AmuxAnalysisNode | AmuxAnalysisCard | AmuxAnalysisEvidence>;
};

type InspectionCode =
  | "schema_rejected"
  | "too_large"
  | "content_refused"
  | "source_ref_unapproved"
  | "target_ref_unapproved"
  | "metadata_incomplete";

/** Which schema rule refused a chunk. Rules, field names and unit positions
 * come from this schema, never from the answer, so they may be shown. */
export const AMUX_ANALYSIS_SCHEMA_RULES = [
  "json_unparsable", "json_fenced", "not_object", "key_missing", "key_extra", "value_not_allowed",
  "ref_format", "local_id_format", "metric_not_rating", "header_mismatch",
  "display_prefix_refused", "initiative_parent", "story_fields", "task_fields",
  "story_expected_paths", "duplicate_value", "unit_kind", "signal_missing",
  "prefix_before_schema_4", "task_expected_paths_missing", "task_review_role",
  "paths_before_schema_5", "local_id_duplicate", "parent_level", "feature_ref_kind",
  "parent_story_ref", "story_dependency", "dependency_ref_kind",
  "duplicate_candidate_ref_kind", "evidence_card_ref", "dependency_cycle",
  "outcome_combination",
] as const;
export type AmuxAnalysisSchemaRule = (typeof AMUX_ANALYSIS_SCHEMA_RULES)[number];

export const AMUX_ANALYSIS_SCHEMA_FIELDS = [
  "chunk", "unit", "node", "card", "evidence", "metrics",
  "schemaVersion", "previewId", "chunkIndex", "outcome", "coverageStatus", "continuationKind",
  "ownerQuestion", "coveredScope", "remainingScope", "units",
  "kind", "localId", "level", "parentRef", "title", "description", "sourceRefIds",
  "portfolioSignal", "displayPrefix", "cardType", "storyKind", "problem", "scopeIn", "scopeOut",
  "completionCriteria", "featureRef", "parentStoryRef", "dependencyRefs", "duplicateCandidateRefs",
  "taskRole", "executionGrade", "executionBrief", "expectedPaths",
  "uncertainty", "rationale", "evidenceRefIds", "evidenceType", "summary", "cardRef",
  "value", "impact", "contribution", "urgency", "dependencyUnlock", "workerCoverage", "effort",
  "deliveryRisk",
] as const;
export type AmuxAnalysisSchemaField = (typeof AMUX_ANALYSIS_SCHEMA_FIELDS)[number];

export type AmuxAnalysisSchemaRejectAt = {
  rule: AmuxAnalysisSchemaRule;
  field?: AmuxAnalysisSchemaField;
  /** Position in the answer's units array, when one unit broke the rule. */
  unit?: number;
  kind?: "node" | "card" | "evidence";
};

export type AmuxAnalysisChunkInspection =
  | { ok: true; chunk: AmuxAnalysisChunk; canonical: string; counts: { nodes: number; cards: number; evidence: number } }
  | { ok: false; code: InspectionCode; at?: AmuxAnalysisSchemaRejectAt };

class InspectionFailure extends Error {
  readonly code: InspectionCode;
  at?: AmuxAnalysisSchemaRejectAt;

  constructor(code: InspectionCode, at?: AmuxAnalysisSchemaRejectAt) {
    super(code);
    this.code = code;
    this.at = at;
  }
}

const reject = (code: InspectionCode): never => { throw new InspectionFailure(code); };
const refuse = (rule: AmuxAnalysisSchemaRule, field?: AmuxAnalysisSchemaField): never => {
  throw new InspectionFailure("schema_rejected", field === undefined ? { rule } : { rule, field });
};
const schemaField = (key: string): AmuxAnalysisSchemaField | undefined =>
  (AMUX_ANALYSIS_SCHEMA_FIELDS as readonly string[]).includes(key) ? key as AmuxAnalysisSchemaField : undefined;

/** Pins a failure inside one unit to that unit's position and kind. */
const atUnit = <T>(index: number, value: unknown, check: () => T): T => {
  try {
    return check();
  } catch (error) {
    if (error instanceof InspectionFailure && error.at && error.at.unit === undefined) {
      const kind = value !== null && typeof value === "object" ? (value as { kind?: unknown }).kind : undefined;
      error.at = { ...error.at, unit: index,
        ...(kind === "node" || kind === "card" || kind === "evidence" ? { kind } : {}) };
    }
    throw error;
  }
};

const object = (value: unknown, keys: readonly string[], scope: AmuxAnalysisSchemaField): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse("not_object", scope);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    const missing = expected.find((key) => !Object.hasOwn(record, key));
    if (missing !== undefined) refuse("key_missing", schemaField(missing));
    refuse("key_extra", scope);
  }
  return record;
};

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], field: AmuxAnalysisSchemaField): T => {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) refuse("value_not_allowed", field);
  return value as T;
};

const ref = (value: unknown, field: AmuxAnalysisSchemaField): string => {
  if (typeof value !== "string" || !REF.test(value)) return refuse("ref_format", field);
  if (!amuxAnalysisRefSafe(value)) return reject("content_refused");
  return value;
};

const nullableRef = (value: unknown, field: AmuxAnalysisSchemaField): string | null =>
  value === null ? null : ref(value, field);

const wellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

/** Shared inbound/outbound content boundary for AMUX v4 model text. */
export const amuxAnalysisTextSafe = (value: string): boolean =>
  wellFormedUnicode(value) && !SPOOFING_CHAR.test(value) && scanAmuxV4Input(value).ok;

/** Source text keeps its exact bytes; only a paired CRLF is accepted in
 * addition to the stricter stored-output character set. */
export const amuxAnalysisInputTextSafe = (value: string): boolean =>
  wellFormedUnicode(value) && !SPOOFING_CHAR.test(value.replaceAll("\r\n", "\n")) &&
  scanAmuxV4Input(value).ok;

const text = (value: unknown, maxBytes: number, field: AmuxAnalysisSchemaField): string => {
  if (typeof value !== "string") return refuse("value_not_allowed", field);
  if (value.length === 0 || value.trim() !== value || !/\S/u.test(value)) {
    return reject("metadata_incomplete");
  }
  if (byteLength(value) > maxBytes) reject("too_large");
  if (!amuxAnalysisTextSafe(value)) {
    reject("content_refused");
  }
  return value;
};

const nullableText = (value: unknown, maxBytes: number, field: AmuxAnalysisSchemaField): string | null =>
  value === null ? null : text(value, maxBytes, field);

const singleLineText = (value: unknown, maxBytes: number, field: AmuxAnalysisSchemaField): string => {
  const result = text(value, maxBytes, field);
  if (/[\t\n]/u.test(result)) reject("content_refused");
  return result;
};

const list = <T>(value: unknown, max: number, min: number, parse: (item: unknown, index: number) => T,
  field: AmuxAnalysisSchemaField): T[] => {
  if (!Array.isArray(value)) return refuse("value_not_allowed", field);
  if (value.length > max) reject("too_large");
  if (value.length < min) reject("metadata_incomplete");
  return value.map((item, index) => parse(item, index));
};

const uniqueRefs = (value: unknown, max: number, field: AmuxAnalysisSchemaField, min = 0): string[] => {
  const refs = list(value, max, min, (item) => ref(item, field), field);
  if (new Set(refs).size !== refs.length) refuse("duplicate_value", field);
  return refs;
};

const sourceRefs = (value: unknown, permitted: ReadonlySet<string>, field: AmuxAnalysisSchemaField): string[] => {
  const refs = uniqueRefs(value, 16, field, 1);
  if (refs.some((candidate) => !permitted.has(candidate))) reject("source_ref_unapproved");
  return refs;
};

const localId = (value: unknown, kind: "node" | "card" | "evidence", chunkIndex: number): string => {
  if (typeof value !== "string") return refuse("value_not_allowed", "localId");
  const match = LOCAL_ID.exec(value);
  if (!match || match[1] !== String(chunkIndex) || match[2] !== kind) {
    return refuse("local_id_format", "localId");
  }
  return value;
};

const modelSignal = (value: unknown, metricNames: readonly string[],
  permittedUnitRefs: readonly string[]): AmuxPortfolioModelSignal => {
  const signal = object(value, ["metrics", "uncertainty", "rationale", "evidenceRefIds"], "portfolioSignal");
  const metricValues = object(signal.metrics, metricNames, "metrics");
  const metrics: Record<string, number> = {};
  for (const name of metricNames) {
    const rating = metricValues[name];
    if (!Number.isInteger(rating) || typeof rating !== "number" ||
        rating < 0 || rating > 5) refuse("metric_not_rating", schemaField(name));
    metrics[name] = rating as number;
  }
  return { metrics,
    uncertainty: oneOf(signal.uncertainty, ["low", "medium", "high"] as const, "uncertainty"),
    rationale: text(signal.rationale, 500, "rationale"),
    evidenceRefIds: sourceRefs(signal.evidenceRefIds,
      new Set(permittedUnitRefs), "evidenceRefIds"),
  };
};

const parseNode = (value: unknown, permitted: ReadonlySet<string>, chunkIndex: number): AmuxAnalysisNode => {
  const hasSignal = value !== null && typeof value === "object" &&
    Object.hasOwn(value, "portfolioSignal");
  const hasPrefix = value !== null && typeof value === "object" &&
    Object.hasOwn(value, "displayPrefix");
  const data = object(value, ["kind", "localId", "level", "parentRef", "title", "description", "sourceRefIds",
    ...(hasSignal ? ["portfolioSignal"] : []), ...(hasPrefix ? ["displayPrefix"] : [])], "node");
  const level = oneOf(data.level, ["initiative", "epic", "feature"] as const, "level");
  // amux-intake v17: a Feature's proposed card number prefix, never a reserved
  // registration-path prefix (docs/policy/amux-card-display-key.md §4).
  if (hasPrefix && (level !== "feature" || !isAmuxFeatureDisplayPrefix(data.displayPrefix))) {
    refuse("display_prefix_refused", "displayPrefix");
  }
  const parentRef = nullableRef(data.parentRef, "parentRef");
  if ((level === "initiative") !== (parentRef === null)) refuse("initiative_parent", "parentRef");
  const unitSources = sourceRefs(data.sourceRefIds, permitted, "sourceRefIds");
  return {
    kind: "node",
    localId: localId(data.localId, "node", chunkIndex),
    level,
    parentRef,
    title: singleLineText(data.title, 200, "title"),
    description: text(data.description, 2_000, "description"),
    sourceRefIds: unitSources,
    ...(hasSignal ? { portfolioSignal: modelSignal(data.portfolioSignal,
      ["value"], unitSources) } : {}),
    ...(hasPrefix ? { displayPrefix: data.displayPrefix as string } : {}),
  };
};

const parseCard = (value: unknown, permitted: ReadonlySet<string>, chunkIndex: number): AmuxAnalysisCard => {
  const hasSignal = value !== null && typeof value === "object" &&
    Object.hasOwn(value, "portfolioSignal");
  const hasPaths = value !== null && typeof value === "object" &&
    Object.hasOwn(value, "expectedPaths");
  const data = object(value, [
    "kind", "localId", "cardType", "storyKind", "title", "problem", "scopeIn", "scopeOut",
    "completionCriteria", "featureRef", "parentStoryRef", "dependencyRefs", "duplicateCandidateRefs",
    "taskRole", "executionGrade", "executionBrief", "sourceRefIds",
    ...(hasSignal ? ["portfolioSignal"] : []), ...(hasPaths ? ["expectedPaths"] : []),
  ], "card");
  const cardType = oneOf(data.cardType, ["story", "task"] as const, "cardType");
  const storyKind = data.storyKind === null ? null : oneOf(data.storyKind, ["general", "bug"] as const, "storyKind");
  const taskRole = data.taskRole === null ? null : oneOf(data.taskRole, AMUX_TASK_ROLE_PROPOSALS, "taskRole");
  const executionGrade = data.executionGrade === null ? null :
    oneOf(data.executionGrade, AMUX_EXECUTION_GRADE_PROPOSALS, "executionGrade");
  const executionBrief = nullableText(data.executionBrief, 2_000, "executionBrief");
  const parentStoryRef = nullableRef(data.parentStoryRef, "parentStoryRef");
  if (cardType === "story") {
    if (storyKind === null) refuse("story_fields", "storyKind");
    if (taskRole !== null) refuse("story_fields", "taskRole");
    if (executionGrade !== null) refuse("story_fields", "executionGrade");
    if (executionBrief !== null) refuse("story_fields", "executionBrief");
    if (parentStoryRef !== null) refuse("story_fields", "parentStoryRef");
  } else {
    if (storyKind !== null) refuse("task_fields", "storyKind");
    if (taskRole === null) refuse("task_fields", "taskRole");
    if (executionGrade === null) refuse("task_fields", "executionGrade");
    if (executionBrief === null) refuse("task_fields", "executionBrief");
  }
  // amux-intake v20 item 3: a Story has no expected paths.
  if (hasPaths && cardType !== "task") refuse("story_expected_paths", "expectedPaths");
  const expectedPaths = hasPaths ? list(data.expectedPaths, AMUX_TASK_EXPECTED_PATHS_MAX, 1,
    (item) => singleLineText(item, AMUX_TASK_EXPECTED_PATH_MAX_BYTES, "expectedPaths"), "expectedPaths") : null;
  if (expectedPaths && new Set(expectedPaths).size !== expectedPaths.length) refuse("duplicate_value", "expectedPaths");
  const unitSources = sourceRefs(data.sourceRefIds, permitted, "sourceRefIds");
  return {
    kind: "card",
    localId: localId(data.localId, "card", chunkIndex),
    cardType,
    storyKind,
    title: singleLineText(data.title, 200, "title"),
    problem: text(data.problem, 2_000, "problem"),
    scopeIn: list(data.scopeIn, 12, 1, (item) => text(item, 500, "scopeIn"), "scopeIn"),
    scopeOut: list(data.scopeOut, 12, 0, (item) => text(item, 500, "scopeOut"), "scopeOut"),
    completionCriteria: list(data.completionCriteria, 12, 1, (item) => text(item, 500, "completionCriteria"),
      "completionCriteria"),
    featureRef: ref(data.featureRef, "featureRef"),
    parentStoryRef,
    dependencyRefs: uniqueRefs(data.dependencyRefs, 16, "dependencyRefs"),
    duplicateCandidateRefs: uniqueRefs(data.duplicateCandidateRefs, 8, "duplicateCandidateRefs"),
    taskRole,
    executionGrade,
    executionBrief,
    sourceRefIds: unitSources,
    ...(hasSignal ? { portfolioSignal: modelSignal(data.portfolioSignal,
      cardType === "story" ? ["impact"] : ["contribution", "urgency",
        "dependencyUnlock", "workerCoverage", "effort", "deliveryRisk"],
      unitSources) } : {}),
    ...(expectedPaths ? { expectedPaths } : {}),
  };
};

const parseEvidence = (value: unknown, permitted: ReadonlySet<string>, chunkIndex: number): AmuxAnalysisEvidence => {
  const data = object(value, ["kind", "localId", "evidenceType", "summary", "cardRef", "sourceRefIds"], "evidence");
  return {
    kind: "evidence",
    localId: localId(data.localId, "evidence", chunkIndex),
    evidenceType: oneOf(data.evidenceType, ["observed_error", "source_finding"] as const, "evidenceType"),
    summary: text(data.summary, 1_000, "summary"),
    cardRef: ref(data.cardRef, "cardRef"),
    sourceRefIds: sourceRefs(data.sourceRefIds, permitted, "sourceRefIds"),
  };
};

const parseUnit = (value: unknown, permitted: ReadonlySet<string>, chunkIndex: number): AmuxAnalysisChunk["units"][number] => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse("not_object", "unit");
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "node") return parseNode(value, permitted, chunkIndex);
  if (kind === "card") return parseCard(value, permitted, chunkIndex);
  if (kind === "evidence") return parseEvidence(value, permitted, chunkIndex);
  return refuse("unit_kind", "kind");
};

/** Re-check one digest-verified, stored unit after other units or the 24-hour
 * freeform have been purged. This does not resolve cross-unit references or
 * admit new model output; the full chunk guard must run before storage. */
export function inspectAmuxStoredAnalysisUnit(input: {
  raw: string; chunkIndex: number; permittedSourceRefIds: readonly string[];
}): { ok: true; unit: AmuxAnalysisChunk["units"][number] } |
  { ok: false } {
  if (typeof input?.raw !== "string" || byteLength(input.raw) > AMUX_ANALYSIS_CHUNK_MAX_BYTES ||
      !Number.isSafeInteger(input.chunkIndex) || input.chunkIndex < 0 ||
      !Array.isArray(input.permittedSourceRefIds) ||
      input.permittedSourceRefIds.some((refId) => !amuxAnalysisRefSafe(refId))) {
    return { ok: false };
  }
  try {
    return { ok: true, unit: parseUnit(JSON.parse(input.raw),
      new Set(input.permittedSourceRefIds), input.chunkIndex) };
  } catch { return { ok: false }; }
}

type TargetRef = AmuxPermittedTargetRef | AmuxAnalysisNode | AmuxAnalysisCard;

/** This resolves only refs supplied in the trusted preview or present in this
 * chunk. DB existence, parent revision and owner approval are later guards. */
const validateUnitRefs = (units: AmuxAnalysisChunk["units"], permitted: readonly AmuxPermittedTargetRef[]): void => {
  const targets = new Map<string, TargetRef>();
  for (const target of permitted) {
    if (targets.has(target.ref)) reject("metadata_incomplete");
    targets.set(target.ref, target);
  }
  for (const unit of units) {
    if (unit.kind !== "evidence") {
      if (targets.has(unit.localId)) reject("metadata_incomplete");
      targets.set(unit.localId, unit);
    }
  }
  const resolve = (value: string): TargetRef => targets.get(value) ?? reject("target_ref_unapproved");
  const localTasks = new Map<string, AmuxAnalysisCard>();
  units.forEach((unit, index) => atUnit(index, unit, () => {
    if (unit.kind === "node" && unit.parentRef !== null) {
      const parent = resolve(unit.parentRef);
      const expected = unit.level === "epic" ? "initiative" : "epic";
      if (parent.kind !== "node" || parent.level !== expected || unit.parentRef === unit.localId) {
        refuse("parent_level", "parentRef");
      }
    } else if (unit.kind === "card") {
      const feature = resolve(unit.featureRef);
      if (feature.kind !== "node" || feature.level !== "feature") refuse("feature_ref_kind", "featureRef");
      if (unit.parentStoryRef !== null) {
        const story = resolve(unit.parentStoryRef);
        if (story.kind !== "card" || story.cardType !== "story" || story.featureRef !== unit.featureRef) {
          refuse("parent_story_ref", "parentStoryRef");
        }
      }
      if (unit.cardType === "story" && unit.dependencyRefs.length !== 0) refuse("story_dependency", "dependencyRefs");
      for (const dependencyRef of unit.dependencyRefs) {
        const dependency = resolve(dependencyRef);
        if (dependency.kind !== "card" || dependency.cardType !== "task" || dependencyRef === unit.localId) {
          refuse("dependency_ref_kind", "dependencyRefs");
        }
      }
      for (const duplicateRef of unit.duplicateCandidateRefs) {
        if (resolve(duplicateRef).kind !== "card" || duplicateRef === unit.localId) {
          refuse("duplicate_candidate_ref_kind", "duplicateCandidateRefs");
        }
      }
      if (unit.cardType === "task") localTasks.set(unit.localId, unit);
    } else if (unit.kind === "evidence") {
      const card = resolve(unit.cardRef);
      if (card.kind !== "card" ||
          (unit.evidenceType === "observed_error" && (card.cardType !== "story" || card.storyKind !== "bug"))) {
        refuse("evidence_card_ref", "cardRef");
      }
    }
  }));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (taskId: string): void => {
    if (visiting.has(taskId)) refuse("dependency_cycle", "dependencyRefs");
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependencyRef of localTasks.get(taskId)?.dependencyRefs ?? []) {
      if (localTasks.has(dependencyRef)) walk(dependencyRef);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const taskId of localTasks.keys()) walk(taskId);
};

type AmuxAnalysisChunkInspectionInput = {
  raw: string;
  expectedPreviewId: string;
  /** Global idea-scoped identity used in the model's localId prefix. */
  expectedChunkIndex: number;
  /** Zero-based position within the immutable source-plan revision. */
  expectedRevisionChunkIndex: number;
  /** Prior chunk's continuationKind from a digest-verified app DB row. */
  previousContinuationKind: "input" | "output" | null;
  permittedSourceRefIds: readonly string[];
  permittedTargetRefs: readonly AmuxPermittedTargetRef[];
  /** The schema the prompt that produced this response asked for. A new model
   * response is admitted only under it, so declaring an older schema cannot
   * skip the newer contract (amux-intake v20). Null only when re-reading a
   * stored, digest-verified chunk, whose schema was fixed when it was admitted. */
  requiredSchemaVersion: AmuxAnalysisChunk["schemaVersion"] | null;
};

const SCHEMA_VERSIONS: readonly unknown[] = [2, 3, 4, AMUX_ANALYSIS_CHUNK_SCHEMA_VERSION];

const snapshotInspectionInput = (input: AmuxAnalysisChunkInspectionInput): {
  raw: string;
  expectedPreviewId: string;
  expectedChunkIndex: number;
  expectedRevisionChunkIndex: number;
  previousContinuationKind: "input" | "output" | null;
  sourceRefs: string[];
  targetRefs: AmuxPermittedTargetRef[];
  requiredSchemaVersion: AmuxAnalysisChunk["schemaVersion"] | null;
} | null => {
  try {
    if (!input || typeof input !== "object") return null;
    const { raw, expectedPreviewId, expectedChunkIndex, expectedRevisionChunkIndex,
      previousContinuationKind,
      permittedSourceRefIds, permittedTargetRefs, requiredSchemaVersion } = input;
    if (typeof raw !== "string" || !amuxAnalysisRefSafe(expectedPreviewId) ||
        !Number.isSafeInteger(expectedChunkIndex) || expectedChunkIndex < 0 ||
        !Number.isSafeInteger(expectedRevisionChunkIndex) ||
        expectedRevisionChunkIndex < 0 || expectedRevisionChunkIndex > expectedChunkIndex ||
        (expectedRevisionChunkIndex === 0 ? previousContinuationKind !== null :
          previousContinuationKind !== "input" && previousContinuationKind !== "output") ||
        !Array.isArray(permittedSourceRefIds) || !Array.isArray(permittedTargetRefs) ||
        !(requiredSchemaVersion === null || SCHEMA_VERSIONS.includes(requiredSchemaVersion))) return null;
    const sourceRefs = copyBoundedAmuxArray<string>(permittedSourceRefIds, 256);
    const rawTargets = copyBoundedAmuxArray<AmuxPermittedTargetRef>(permittedTargetRefs, 512);
    if (sourceRefs === null || rawTargets === null || sourceRefs.length === 0 ||
        sourceRefs.some((candidate) => !amuxAnalysisRefSafe(candidate))) return null;
    const targetRefs = rawTargets.map((target) => snapshotAmuxPermittedTarget(target));
    if (targetRefs.some((target) => target === null)) return null;
    const verifiedTargets = targetRefs as AmuxPermittedTargetRef[];
    if (verifiedTargets.some((target) => !amuxPermittedTargetRefSafe(target, expectedChunkIndex))) return null;
    return { raw, expectedPreviewId, expectedChunkIndex, expectedRevisionChunkIndex,
      previousContinuationKind,
      sourceRefs, targetRefs: verifiedTargets, requiredSchemaVersion };
  } catch {
    return null;
  }
};

export function inspectAmuxAnalysisChunk(
  input: AmuxAnalysisChunkInspectionInput,
): AmuxAnalysisChunkInspection {
  const snapshot = snapshotInspectionInput(input);
  if (snapshot === null) return { ok: false, code: "metadata_incomplete" };
  const { raw, expectedPreviewId, expectedChunkIndex, previousContinuationKind,
    sourceRefs, targetRefs, requiredSchemaVersion } = snapshot;
  if (byteLength(raw) > AMUX_ANALYSIS_CHUNK_MAX_BYTES) return { ok: false, code: "too_large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "schema_rejected",
      at: { rule: raw.trimStart().startsWith("```") ? "json_fenced" : "json_unparsable" } };
  }
  try {
    const data = object(parsed, [
      "schemaVersion", "previewId", "chunkIndex", "outcome", "coverageStatus", "continuationKind", "ownerQuestion",
      "coveredScope", "remainingScope", "units",
    ], "chunk");
    if ((data.schemaVersion !== 2 && data.schemaVersion !== 3 && data.schemaVersion !== 4 &&
         data.schemaVersion !== AMUX_ANALYSIS_CHUNK_SCHEMA_VERSION) ||
        (requiredSchemaVersion !== null && data.schemaVersion !== requiredSchemaVersion)) {
      refuse("header_mismatch", "schemaVersion");
    }
    if (data.previewId !== expectedPreviewId) refuse("header_mismatch", "previewId");
    if (data.chunkIndex !== expectedChunkIndex) refuse("header_mismatch", "chunkIndex");
    const permitted = new Set(sourceRefs);
    const units = list(data.units, AMUX_ANALYSIS_CHUNK_CARD_CAP + AMUX_ANALYSIS_CHUNK_NODE_CAP +
      AMUX_ANALYSIS_CHUNK_EVIDENCE_CAP, 0,
      (unit, index) => atUnit(index, unit, () => parseUnit(unit, permitted, expectedChunkIndex)), "units");
    const firstUnit = (broken: (unit: AmuxAnalysisChunk["units"][number]) => boolean,
      rule: AmuxAnalysisSchemaRule, field: AmuxAnalysisSchemaField): void => {
      const index = units.findIndex(broken);
      if (index >= 0) atUnit(index, units[index], () => refuse(rule, field));
    };
    // Schema 3 made portfolio signals mandatory; schema 4 keeps that.
    if (data.schemaVersion !== 2) {
      firstUnit((unit) => unit.kind !== "evidence" && !unit.portfolioSignal, "signal_missing", "portfolioSignal");
    }
    // A Feature prefix proposal exists only from schema 4 (amux-intake v17).
    if (data.schemaVersion === 2 || data.schemaVersion === 3) {
      firstUnit((unit) => unit.kind === "node" && unit.displayPrefix !== undefined,
        "prefix_before_schema_4", "displayPrefix");
    }
    // amux-intake v20: from schema 5 every Task names its expected paths and
    // no Task is a review Task; before it, no unit has expected paths. Stored
    // units are re-read by inspectAmuxStoredAnalysisUnit, which keeps both.
    if (data.schemaVersion === AMUX_ANALYSIS_CHUNK_SCHEMA_VERSION) {
      const task = (unit: AmuxAnalysisChunk["units"][number]) => unit.kind === "card" && unit.cardType === "task";
      firstUnit((unit) => task(unit) && unit.kind === "card" && unit.expectedPaths === undefined,
        "task_expected_paths_missing", "expectedPaths");
      firstUnit((unit) => task(unit) && unit.kind === "card" && unit.taskRole === "review",
        "task_review_role", "taskRole");
    } else {
      firstUnit((unit) => unit.kind === "card" && unit.expectedPaths !== undefined,
        "paths_before_schema_5", "expectedPaths");
    }
    const counts = {
      nodes: units.filter((unit) => unit.kind === "node").length,
      cards: units.filter((unit) => unit.kind === "card").length,
      evidence: units.filter((unit) => unit.kind === "evidence").length,
    };
    if (counts.nodes > AMUX_ANALYSIS_CHUNK_NODE_CAP || counts.cards > AMUX_ANALYSIS_CHUNK_CARD_CAP ||
        counts.evidence > AMUX_ANALYSIS_CHUNK_EVIDENCE_CAP) reject("too_large");
    firstUnit((unit) => units.findIndex((other) => other.localId === unit.localId) !== units.indexOf(unit),
      "local_id_duplicate", "localId");
    validateUnitRefs(units, targetRefs);
    const outcome = oneOf(data.outcome, ["propose", "needs_information", "reject"] as const, "outcome");
    const coverageStatus = oneOf(data.coverageStatus, ["complete", "more", "needs_owner_input"] as const,
      "coverageStatus");
    const continuationKind = data.continuationKind === null ? null :
      oneOf(data.continuationKind, ["input", "output"] as const, "continuationKind");
    const ownerQuestion = nullableText(data.ownerQuestion, 2_000, "ownerQuestion");
    const remainingScope = nullableText(data.remainingScope, 2_000, "remainingScope");
    if ((remainingScope === null) !== (continuationKind === null) ||
        (coverageStatus === "complete" && continuationKind !== null) ||
        (coverageStatus === "more" && continuationKind === null) ||
        (coverageStatus === "needs_owner_input" && continuationKind === "output") ||
        (coverageStatus === "needs_owner_input") !== (ownerQuestion !== null) ||
        (continuationKind === "output" && outcome !== "propose") ||
        (continuationKind === "output" && counts.cards === 0) ||
        (previousContinuationKind === "output" &&
          (outcome === "reject" || (outcome === "propose" && counts.cards === 0) ||
           (outcome === "needs_information" && continuationKind !== "input"))) ||
        (outcome === "needs_information") !== (coverageStatus === "needs_owner_input") ||
        (outcome === "reject" && coverageStatus !== "complete") ||
        (outcome === "propose" && units.length === 0) ||
        (outcome === "reject" && units.length !== 0)) refuse("outcome_combination", "outcome");
    const chunk: AmuxAnalysisChunk = {
      schemaVersion: data.schemaVersion as AmuxAnalysisChunk["schemaVersion"],
      previewId: expectedPreviewId,
      chunkIndex: expectedChunkIndex,
      outcome,
      coverageStatus,
      continuationKind,
      ownerQuestion,
      coveredScope: text(data.coveredScope, 2_000, "coveredScope"),
      remainingScope,
      units,
    };
    const canonical = amuxCanonicalJson(chunk);
    if (byteLength(canonical) > AMUX_ANALYSIS_CHUNK_MAX_BYTES) reject("too_large");
    // A long-lived digest of model-derived content must be keyed. The future
    // app writer computes it with its own key after this structural check;
    // this no-credential parser intentionally returns no plain SHA-256.
    return { ok: true, chunk, canonical, counts };
  } catch (error) {
    if (error instanceof InspectionFailure) {
      return error.at ? { ok: false, code: error.code, at: error.at } : { ok: false, code: error.code };
    }
    throw error;
  }
}
