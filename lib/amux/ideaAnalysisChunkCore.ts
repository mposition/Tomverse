import { amuxCanonicalJson } from "./boardImportCore.ts";
import { scanLocalIntakeInput } from "./localIntakeCore.ts";

/**
 * Structural admission for one untrusted AMUX v4 model response. This is not
 * an approval, source-provenance proof, hierarchy resolver, or DB writer.
 * The trusted caller supplies the source-ref allowlist from the confirmed
 * transfer preview; the model cannot grant itself another source.
 */
export const AMUX_ANALYSIS_CHUNK_SCHEMA_VERSION = 1 as const;
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

export type AmuxPermittedTargetRef =
  | { ref: string; kind: "node"; level: "initiative" | "epic" | "feature" }
  | { ref: string; kind: "card"; cardType: "story" | "task"; storyKind: "general" | "bug" | null; featureRef: string };

export type AmuxAnalysisNode = {
  kind: "node";
  localId: string;
  level: "initiative" | "epic" | "feature";
  parentRef: string | null;
  title: string;
  description: string;
  sourceRefIds: string[];
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
  schemaVersion: typeof AMUX_ANALYSIS_CHUNK_SCHEMA_VERSION;
  previewId: string;
  chunkIndex: number;
  outcome: "propose" | "needs_information" | "reject";
  coverageStatus: "complete" | "more" | "needs_owner_input";
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
  if (!scanLocalIntakeInput(value).ok) return reject("content_refused");
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

const text = (value: unknown, maxBytes: number): string => {
  if (typeof value !== "string") return reject("schema_rejected");
  if (value.length === 0 || value.trim() !== value || !/\S/u.test(value)) {
    return reject("metadata_incomplete");
  }
  if (byteLength(value) > maxBytes) reject("too_large");
  if (!wellFormedUnicode(value) || SPOOFING_CHAR.test(value) || !scanLocalIntakeInput(value).ok) {
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

const parseNode = (value: unknown, permitted: ReadonlySet<string>, chunkIndex: number): AmuxAnalysisNode => {
  const data = object(value, ["kind", "localId", "level", "parentRef", "title", "description", "sourceRefIds"]);
  const level = oneOf(data.level, ["initiative", "epic", "feature"] as const);
  const parentRef = nullableRef(data.parentRef);
  if ((level === "initiative") !== (parentRef === null)) reject("schema_rejected");
  return {
    kind: "node",
    localId: localId(data.localId, "node", chunkIndex),
    level,
    parentRef,
    title: singleLineText(data.title, 200),
    description: text(data.description, 2_000),
    sourceRefIds: sourceRefs(data.sourceRefIds, permitted),
  };
};

const parseCard = (value: unknown, permitted: ReadonlySet<string>, chunkIndex: number): AmuxAnalysisCard => {
  const data = object(value, [
    "kind", "localId", "cardType", "storyKind", "title", "problem", "scopeIn", "scopeOut",
    "completionCriteria", "featureRef", "parentStoryRef", "dependencyRefs", "duplicateCandidateRefs",
    "taskRole", "executionGrade", "executionBrief", "sourceRefIds",
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
    sourceRefIds: sourceRefs(data.sourceRefIds, permitted),
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

export function inspectAmuxAnalysisChunk(input: {
  raw: string;
  expectedPreviewId: string;
  expectedChunkIndex: number;
  permittedSourceRefIds: readonly string[];
  permittedTargetRefs: readonly AmuxPermittedTargetRef[];
}): AmuxAnalysisChunkInspection {
  if (!input || typeof input !== "object" || typeof input.raw !== "string" ||
      typeof input.expectedPreviewId !== "string" || !REF.test(input.expectedPreviewId) ||
      !Number.isSafeInteger(input.expectedChunkIndex) ||
      input.expectedChunkIndex < 0 || !Array.isArray(input.permittedSourceRefIds) ||
      input.permittedSourceRefIds.length === 0 ||
      input.permittedSourceRefIds.length > 256 ||
      input.permittedSourceRefIds.some((candidate) => typeof candidate !== "string" || !REF.test(candidate)) ||
      !Array.isArray(input.permittedTargetRefs) || input.permittedTargetRefs.length > 512 ||
      input.permittedTargetRefs.some((target) => {
        if (!target || typeof target !== "object" || typeof target.ref !== "string" ||
            !REF.test(target.ref) || !scanLocalIntakeInput(target.ref).ok) return true;
        const priorLocal = LOCAL_ID.exec(target.ref);
        if (priorLocal && (Number(priorLocal[1]) >= input.expectedChunkIndex || priorLocal[2] !== target.kind)) {
          return true;
        }
        if (target.kind === "node") return !["initiative", "epic", "feature"].includes(target.level);
        if (target.kind === "card") return !["story", "task"].includes(target.cardType) ||
          (target.cardType === "story" ? !["general", "bug"].includes(target.storyKind as string) : target.storyKind !== null) ||
          typeof target.featureRef !== "string" || !REF.test(target.featureRef);
        return true;
      })) {
    return { ok: false, code: "metadata_incomplete" };
  }
  if (byteLength(input.raw) > AMUX_ANALYSIS_CHUNK_MAX_BYTES) return { ok: false, code: "too_large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw);
  } catch {
    return { ok: false, code: "schema_rejected" };
  }
  try {
    const data = object(parsed, [
      "schemaVersion", "previewId", "chunkIndex", "outcome", "coverageStatus", "coveredScope", "remainingScope", "units",
    ]);
    if (data.schemaVersion !== AMUX_ANALYSIS_CHUNK_SCHEMA_VERSION ||
        data.previewId !== input.expectedPreviewId || data.chunkIndex !== input.expectedChunkIndex) {
      reject("schema_rejected");
    }
    const permitted = new Set(input.permittedSourceRefIds);
    const units = list(data.units, AMUX_ANALYSIS_CHUNK_CARD_CAP + AMUX_ANALYSIS_CHUNK_NODE_CAP +
      AMUX_ANALYSIS_CHUNK_EVIDENCE_CAP, 0, (unit) => parseUnit(unit, permitted, input.expectedChunkIndex));
    const counts = {
      nodes: units.filter((unit) => unit.kind === "node").length,
      cards: units.filter((unit) => unit.kind === "card").length,
      evidence: units.filter((unit) => unit.kind === "evidence").length,
    };
    if (counts.nodes > AMUX_ANALYSIS_CHUNK_NODE_CAP || counts.cards > AMUX_ANALYSIS_CHUNK_CARD_CAP ||
        counts.evidence > AMUX_ANALYSIS_CHUNK_EVIDENCE_CAP) reject("too_large");
    if (new Set(units.map((unit) => unit.localId)).size !== units.length) reject("schema_rejected");
    validateUnitRefs(units, input.permittedTargetRefs);
    const outcome = oneOf(data.outcome, ["propose", "needs_information", "reject"] as const);
    const coverageStatus = oneOf(data.coverageStatus, ["complete", "more", "needs_owner_input"] as const);
    const remainingScope = nullableText(data.remainingScope, 2_000);
    if ((coverageStatus === "complete") !== (remainingScope === null) ||
        (outcome === "needs_information") !== (coverageStatus === "needs_owner_input") ||
        (outcome === "reject" && coverageStatus !== "complete") ||
        (outcome === "propose" && units.length === 0) ||
        (outcome === "reject" && units.length !== 0)) reject("schema_rejected");
    const chunk: AmuxAnalysisChunk = {
      schemaVersion: AMUX_ANALYSIS_CHUNK_SCHEMA_VERSION,
      previewId: input.expectedPreviewId,
      chunkIndex: input.expectedChunkIndex,
      outcome,
      coverageStatus,
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
