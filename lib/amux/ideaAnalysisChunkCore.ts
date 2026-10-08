import { amuxCanonicalJson } from "./boardImportCore.ts";
import { scanAmuxV4Input } from "./localIntakeCore.ts";

/**
 * Structural admission for one untrusted AMUX v4 model response. This is not
 * an approval, source-provenance proof, hierarchy resolver, or DB writer.
 * The trusted caller supplies the source-ref allowlist from the confirmed
 * transfer preview; the model cannot grant itself another source.
 */
export const AMUX_ANALYSIS_CHUNK_SCHEMA_VERSION = 3 as const;
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
  schemaVersion: 2 | typeof AMUX_ANALYSIS_CHUNK_SCHEMA_VERSION;
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

export type AmuxAnalysisChunkInspection =
  | { ok: true; chunk: AmuxAnalysisChunk; canonical: string; counts: { nodes: number; cards: number; evidence: number } }
  | { ok: false; code: InspectionCode };

class InspectionFailure extends Error {
  readonly code: InspectionCode;

  constructor(code: InspectionCode) {
    super(code);
    this.code = code;
  }
}

const reject = (code: InspectionCode): never => { throw new InspectionFailure(code); };

const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject("schema_rejected");
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    reject("schema_rejected");
  }
  return record;
};

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T => {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) reject("schema_rejected");
  return value as T;
};

const ref = (value: unknown): string => {
  if (typeof value !== "string" || !REF.test(value)) return reject("schema_rejected");
  if (!amuxAnalysisRefSafe(value)) return reject("content_refused");
  return value;
};

const nullableRef = (value: unknown): string | null => value === null ? null : ref(value);

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

const text = (value: unknown, maxBytes: number): string => {
  if (typeof value !== "string") return reject("schema_rejected");
  if (value.length === 0 || value.trim() !== value || !/\S/u.test(value)) {
    return reject("metadata_incomplete");
  }
  if (byteLength(value) > maxBytes) reject("too_large");
  if (!amuxAnalysisTextSafe(value)) {
    reject("content_refused");
  }
  return value;
};

const nullableText = (value: unknown, maxBytes: number): string | null =>
  value === null ? null : text(value, maxBytes);

const singleLineText = (value: unknown, maxBytes: number): string => {
  const result = text(value, maxBytes);
  if (/[\t\n]/u.test(result)) reject("content_refused");
  return result;
};

const list = <T>(value: unknown, max: number, min: number, parse: (item: unknown) => T): T[] => {
  if (!Array.isArray(value)) return reject("schema_rejected");
  if (value.length > max) reject("too_large");
  if (value.length < min) reject("metadata_incomplete");
  return value.map(parse);
};

const uniqueRefs = (value: unknown, max: number, min = 0): string[] => {
  const refs = list(value, max, min, ref);
  if (new Set(refs).size !== refs.length) reject("schema_rejected");
  return refs;
};

const sourceRefs = (value: unknown, permitted: ReadonlySet<string>): string[] => {
  const refs = uniqueRefs(value, 16, 1);
  if (refs.some((candidate) => !permitted.has(candidate))) reject("source_ref_unapproved");
  return refs;
};

const localId = (value: unknown, kind: "node" | "card" | "evidence", chunkIndex: number): string => {
  if (typeof value !== "string") return reject("schema_rejected");
  const match = LOCAL_ID.exec(value);
  if (!match || match[1] !== String(chunkIndex) || match[2] !== kind) {
    return reject("schema_rejected");
  }
  return value;
};

const modelSignal = (value: unknown, metricNames: readonly string[],
  permittedUnitRefs: readonly string[]): AmuxPortfolioModelSignal => {
  const signal = object(value, ["metrics", "uncertainty", "rationale", "evidenceRefIds"]);
  const metricValues = object(signal.metrics, metricNames);
  const metrics: Record<string, number> = {};
  for (const name of metricNames) {
    const rating = metricValues[name];
    if (!Number.isInteger(rating) || typeof rating !== "number" ||
        rating < 0 || rating > 5) reject("schema_rejected");
    metrics[name] = rating as number;
  }
  return { metrics,
    uncertainty: oneOf(signal.uncertainty, ["low", "medium", "high"] as const),
    rationale: text(signal.rationale, 500),
    evidenceRefIds: sourceRefs(signal.evidenceRefIds,
      new Set(permittedUnitRefs)),
  };
};

const parseNode = (value: unknown, permitted: ReadonlySet<string>, chunkIndex: number): AmuxAnalysisNode => {
  const hasSignal = value !== null && typeof value === "object" &&
    Object.hasOwn(value, "portfolioSignal");
  const data = object(value, ["kind", "localId", "level", "parentRef", "title", "description", "sourceRefIds",
    ...(hasSignal ? ["portfolioSignal"] : [])]);
  const level = oneOf(data.level, ["initiative", "epic", "feature"] as const);
  const parentRef = nullableRef(data.parentRef);
  if ((level === "initiative") !== (parentRef === null)) reject("schema_rejected");
  const unitSources = sourceRefs(data.sourceRefIds, permitted);
  return {
    kind: "node",
    localId: localId(data.localId, "node", chunkIndex),
    level,
    parentRef,
    title: singleLineText(data.title, 200),
    description: text(data.description, 2_000),
    sourceRefIds: unitSources,
    ...(hasSignal ? { portfolioSignal: modelSignal(data.portfolioSignal,
      ["value"], unitSources) } : {}),
  };
};

const parseCard = (value: unknown, permitted: ReadonlySet<string>, chunkIndex: number): AmuxAnalysisCard => {
  const hasSignal = value !== null && typeof value === "object" &&
    Object.hasOwn(value, "portfolioSignal");
  const data = object(value, [
    "kind", "localId", "cardType", "storyKind", "title", "problem", "scopeIn", "scopeOut",
    "completionCriteria", "featureRef", "parentStoryRef", "dependencyRefs", "duplicateCandidateRefs",
    "taskRole", "executionGrade", "executionBrief", "sourceRefIds",
    ...(hasSignal ? ["portfolioSignal"] : []),
  ]);
  const cardType = oneOf(data.cardType, ["story", "task"] as const);
  const storyKind = data.storyKind === null ? null : oneOf(data.storyKind, ["general", "bug"] as const);
  const taskRole = data.taskRole === null ? null : oneOf(data.taskRole, AMUX_TASK_ROLE_PROPOSALS);
  const executionGrade = data.executionGrade === null ? null : oneOf(data.executionGrade, AMUX_EXECUTION_GRADE_PROPOSALS);
  const executionBrief = nullableText(data.executionBrief, 2_000);
  const parentStoryRef = nullableRef(data.parentStoryRef);
  if (cardType === "story") {
    if (storyKind === null || taskRole !== null || executionGrade !== null ||
        executionBrief !== null || parentStoryRef !== null) reject("schema_rejected");
  } else if (storyKind !== null || taskRole === null || executionGrade === null || executionBrief === null) {
    reject("schema_rejected");
  }
  const unitSources = sourceRefs(data.sourceRefIds, permitted);
  return {
    kind: "card",
    localId: localId(data.localId, "card", chunkIndex),
    cardType,
    storyKind,
    title: singleLineText(data.title, 200),
    problem: text(data.problem, 2_000),
    scopeIn: list(data.scopeIn, 12, 1, (item) => text(item, 500)),
    scopeOut: list(data.scopeOut, 12, 0, (item) => text(item, 500)),
    completionCriteria: list(data.completionCriteria, 12, 1, (item) => text(item, 500)),
    featureRef: ref(data.featureRef),
    parentStoryRef,
    dependencyRefs: uniqueRefs(data.dependencyRefs, 16),
    duplicateCandidateRefs: uniqueRefs(data.duplicateCandidateRefs, 8),
    taskRole,
    executionGrade,
    executionBrief,
    sourceRefIds: unitSources,
    ...(hasSignal ? { portfolioSignal: modelSignal(data.portfolioSignal,
      cardType === "story" ? ["impact"] : ["contribution", "urgency",
        "dependencyUnlock", "workerCoverage", "effort", "deliveryRisk"],
      unitSources) } : {}),
  };
};

const parseEvidence = (value: unknown, permitted: ReadonlySet<string>, chunkIndex: number): AmuxAnalysisEvidence => {
  const data = object(value, ["kind", "localId", "evidenceType", "summary", "cardRef", "sourceRefIds"]);
  return {
    kind: "evidence",
    localId: localId(data.localId, "evidence", chunkIndex),
    evidenceType: oneOf(data.evidenceType, ["observed_error", "source_finding"] as const),
    summary: text(data.summary, 1_000),
    cardRef: ref(data.cardRef),
    sourceRefIds: sourceRefs(data.sourceRefIds, permitted),
  };
};

const parseUnit = (value: unknown, permitted: ReadonlySet<string>, chunkIndex: number): AmuxAnalysisChunk["units"][number] => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject("schema_rejected");
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "node") return parseNode(value, permitted, chunkIndex);
  if (kind === "card") return parseCard(value, permitted, chunkIndex);
  if (kind === "evidence") return parseEvidence(value, permitted, chunkIndex);
  return reject("schema_rejected");
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
  for (const unit of units) {
    if (unit.kind === "node" && unit.parentRef !== null) {
      const parent = resolve(unit.parentRef);
      const expected = unit.level === "epic" ? "initiative" : "epic";
      if (parent.kind !== "node" || parent.level !== expected || unit.parentRef === unit.localId) {
        reject("schema_rejected");
      }
    } else if (unit.kind === "card") {
      const feature = resolve(unit.featureRef);
      if (feature.kind !== "node" || feature.level !== "feature") reject("schema_rejected");
      if (unit.parentStoryRef !== null) {
        const story = resolve(unit.parentStoryRef);
        if (story.kind !== "card" || story.cardType !== "story" || story.featureRef !== unit.featureRef) {
          reject("schema_rejected");
        }
      }
      if (unit.cardType === "story" && unit.dependencyRefs.length !== 0) reject("schema_rejected");
      for (const dependencyRef of unit.dependencyRefs) {
        const dependency = resolve(dependencyRef);
        if (dependency.kind !== "card" || dependency.cardType !== "task" || dependencyRef === unit.localId) {
          reject("schema_rejected");
        }
      }
      for (const duplicateRef of unit.duplicateCandidateRefs) {
        if (resolve(duplicateRef).kind !== "card" || duplicateRef === unit.localId) reject("schema_rejected");
      }
      if (unit.cardType === "task") localTasks.set(unit.localId, unit);
    } else if (unit.kind === "evidence") {
      const card = resolve(unit.cardRef);
      if (card.kind !== "card" ||
          (unit.evidenceType === "observed_error" && (card.cardType !== "story" || card.storyKind !== "bug"))) {
        reject("schema_rejected");
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (taskId: string): void => {
    if (visiting.has(taskId)) reject("schema_rejected");
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
};

const snapshotInspectionInput = (input: AmuxAnalysisChunkInspectionInput): {
  raw: string;
  expectedPreviewId: string;
  expectedChunkIndex: number;
  expectedRevisionChunkIndex: number;
  previousContinuationKind: "input" | "output" | null;
  sourceRefs: string[];
  targetRefs: AmuxPermittedTargetRef[];
} | null => {
  try {
    if (!input || typeof input !== "object") return null;
    const { raw, expectedPreviewId, expectedChunkIndex, expectedRevisionChunkIndex,
      previousContinuationKind,
      permittedSourceRefIds, permittedTargetRefs } = input;
    if (typeof raw !== "string" || !amuxAnalysisRefSafe(expectedPreviewId) ||
        !Number.isSafeInteger(expectedChunkIndex) || expectedChunkIndex < 0 ||
        !Number.isSafeInteger(expectedRevisionChunkIndex) ||
        expectedRevisionChunkIndex < 0 || expectedRevisionChunkIndex > expectedChunkIndex ||
        (expectedRevisionChunkIndex === 0 ? previousContinuationKind !== null :
          previousContinuationKind !== "input" && previousContinuationKind !== "output") ||
        !Array.isArray(permittedSourceRefIds) || !Array.isArray(permittedTargetRefs)) return null;
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
      sourceRefs, targetRefs: verifiedTargets };
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
    sourceRefs, targetRefs } = snapshot;
  if (byteLength(raw) > AMUX_ANALYSIS_CHUNK_MAX_BYTES) return { ok: false, code: "too_large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "schema_rejected" };
  }
  try {
    const data = object(parsed, [
      "schemaVersion", "previewId", "chunkIndex", "outcome", "coverageStatus", "continuationKind", "ownerQuestion",
      "coveredScope", "remainingScope", "units",
    ]);
    if ((data.schemaVersion !== 2 &&
         data.schemaVersion !== AMUX_ANALYSIS_CHUNK_SCHEMA_VERSION) ||
        data.previewId !== expectedPreviewId || data.chunkIndex !== expectedChunkIndex) {
      reject("schema_rejected");
    }
    const permitted = new Set(sourceRefs);
    const units = list(data.units, AMUX_ANALYSIS_CHUNK_CARD_CAP + AMUX_ANALYSIS_CHUNK_NODE_CAP +
      AMUX_ANALYSIS_CHUNK_EVIDENCE_CAP, 0, (unit) => parseUnit(unit, permitted, expectedChunkIndex));
    if (data.schemaVersion === AMUX_ANALYSIS_CHUNK_SCHEMA_VERSION &&
        units.some((unit) => unit.kind !== "evidence" && !unit.portfolioSignal)) {
      reject("schema_rejected");
    }
    const counts = {
      nodes: units.filter((unit) => unit.kind === "node").length,
      cards: units.filter((unit) => unit.kind === "card").length,
      evidence: units.filter((unit) => unit.kind === "evidence").length,
    };
    if (counts.nodes > AMUX_ANALYSIS_CHUNK_NODE_CAP || counts.cards > AMUX_ANALYSIS_CHUNK_CARD_CAP ||
        counts.evidence > AMUX_ANALYSIS_CHUNK_EVIDENCE_CAP) reject("too_large");
    if (new Set(units.map((unit) => unit.localId)).size !== units.length) reject("schema_rejected");
    validateUnitRefs(units, targetRefs);
    const outcome = oneOf(data.outcome, ["propose", "needs_information", "reject"] as const);
    const coverageStatus = oneOf(data.coverageStatus, ["complete", "more", "needs_owner_input"] as const);
    const continuationKind = data.continuationKind === null ? null :
      oneOf(data.continuationKind, ["input", "output"] as const);
    const ownerQuestion = nullableText(data.ownerQuestion, 2_000);
    const remainingScope = nullableText(data.remainingScope, 2_000);
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
        (outcome === "reject" && units.length !== 0)) reject("schema_rejected");
    const chunk: AmuxAnalysisChunk = {
      schemaVersion: data.schemaVersion as 2 | typeof AMUX_ANALYSIS_CHUNK_SCHEMA_VERSION,
      previewId: expectedPreviewId,
      chunkIndex: expectedChunkIndex,
      outcome,
      coverageStatus,
      continuationKind,
      ownerQuestion,
      coveredScope: text(data.coveredScope, 2_000),
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
    if (error instanceof InspectionFailure) return { ok: false, code: error.code };
    throw error;
  }
}
