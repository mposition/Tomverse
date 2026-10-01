import { createHash, createHmac } from "node:crypto";

import { amuxCanonicalJson } from "./boardImportCore.ts";

/**
 * Local Frontier analysis packages for AMUX intake.
 *
 * docs/policy/amux-intake.md (policy version 3).
 *
 * Parsing, scanning and the guard are pure. This module does not open a
 * transaction, call a provider, or create a card. The shipped apply latch is
 * true as of the 2026-09-30 activation. Production registration still needs
 * TOMVERSE_AMUX_INTAKE_LOCAL_APPLY to be exactly enabled.
 */

export const LOCAL_INTAKE_POLICY_VERSION = 3;
export const LOCAL_INTAKE_SCHEMA_VERSION = 1;
export const LOCAL_INTAKE_SOURCE_SYSTEM = "local-agent-intake";
export const LOCAL_INTAKE_AGENT_ID = "amux-intake";
export const LOCAL_INTAKE_CARD_CAP = 8;
export const LOCAL_INTAKE_PACKAGE_MAX_BYTES = 65_536;
export const LOCAL_INTAKE_INPUT_MAX_BYTES = 8_192;
export const LOCAL_INTAKE_TEXT_MAX_BYTES = 2_000;
export const LOCAL_INTAKE_TITLE_MAX_BYTES = 200;
export const LOCAL_INTAKE_ITEM_MAX_BYTES = 500;
export const LOCAL_INTAKE_LIST_CAP = 12;
export const LOCAL_INTAKE_PATH_CAP = 32;
export const LOCAL_INTAKE_DEPENDENCY_CAP = 16;
export const LOCAL_INTAKE_DUPLICATE_CAP = 8;
export const LOCAL_INTAKE_QUESTION_CAP = 12;
export const LOCAL_INTAKE_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const LOCAL_INTAKE_APPLY_ENV = "TOMVERSE_AMUX_INTAKE_LOCAL_APPLY";
export const LOCAL_INTAKE_SOURCE_KEY_SECRET_ENV = "AMUX_INTAKE_LOCAL_SOURCE_KEY_SECRET";
export const LOCAL_INTAKE_APPLY_CODE_LATCH = true;
export const LOCAL_INTAKE_SCANNER_VERSION = "local-amux-intake-scan-v1";
export const AMUX_V4_INPUT_SCANNER_VERSION = "amux-v4-intake-scan-v1";
export const LOCAL_INTAKE_PROMPT_VERSION = "local-amux-intake-prompt-v1";
export const LOCAL_INTAKE_CANONICALIZATION_VERSION = "amux-json-v1";

export const LOCAL_INTAKE_FRONTIER_MODELS = ["gpt-6-astra"] as const;
export const LOCAL_INTAKE_FRONTIER_EFFORTS = ["high", "xhigh"] as const;
export const LOCAL_INTAKE_CLASSIFICATIONS = [
  "bug",
  "production_error",
  "improvement",
  "new_feature",
  "investigation",
] as const;
export const LOCAL_INTAKE_RECOMMENDATIONS = [
  "new_cards",
  "possible_duplicate",
  "extend_existing",
  "needs_information",
  "rejected",
] as const;
export const LOCAL_INTAKE_PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export const LOCAL_INTAKE_KINDS = [
  "blocker",
  "escalation",
  "bug",
  "code",
  "ops",
  "investigation",
  "research",
  "chore",
  "doc",
  "unknown",
] as const;
export const LOCAL_INTAKE_SIZES = ["small", "medium", "large"] as const;
export const LOCAL_INTAKE_APPROVAL_STATUSES = ["consumed", "outcome_unknown"] as const;

const PACKAGE_KEYS = [
  "agentReceipt",
  "analysisId",
  "boardSnapshotDigest",
  "cards",
  "classification",
  "generatedAt",
  "inputDigest",
  "questions",
  "recommendation",
  "schemaVersion",
  "snapshotGeneratedAt",
  "summary",
] as const;
const RECEIPT_KEYS = ["adapter", "model", "promptVersion", "reasoningEffort", "repositoryHeads"] as const;
const HEAD_KEYS = ["privateDocs", "tomverse"] as const;
const CARD_KEYS = [
  "acceptanceCriteria",
  "dependencyIds",
  "duplicateCandidateIds",
  "estimatedSize",
  "evidence",
  "kindProposal",
  "localId",
  "priority",
  "priorityRationale",
  "problem",
  "rationale",
  "repositoryPaths",
  "risks",
  "scopeIn",
  "scopeOut",
  "title",
] as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const ANALYSIS_ID_PATTERN =
  /^local-amux-intake:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCAL_ID_PATTERN = /^card-[0-9]{2}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const RELATIVE_PATH_PATTERN = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

export type LocalIntakeClassification = (typeof LOCAL_INTAKE_CLASSIFICATIONS)[number];
export type LocalIntakeRecommendation = (typeof LOCAL_INTAKE_RECOMMENDATIONS)[number];
export type LocalIntakePriority = (typeof LOCAL_INTAKE_PRIORITIES)[number];
export type LocalIntakeKind = (typeof LOCAL_INTAKE_KINDS)[number];
export type LocalIntakeSize = (typeof LOCAL_INTAKE_SIZES)[number];

export type LocalIntakeCard = {
  localId: string;
  title: string;
  problem: string;
  rationale: string;
  scopeIn: string[];
  scopeOut: string[];
  acceptanceCriteria: string[];
  evidence: string[];
  priority: LocalIntakePriority;
  priorityRationale: string;
  kindProposal: LocalIntakeKind;
  repositoryPaths: string[];
  dependencyIds: string[];
  duplicateCandidateIds: string[];
  risks: string[];
  estimatedSize: LocalIntakeSize;
};

export type LocalIntakePackage = {
  schemaVersion: typeof LOCAL_INTAKE_SCHEMA_VERSION;
  analysisId: string;
  inputDigest: string;
  boardSnapshotDigest: string;
  snapshotGeneratedAt: string;
  generatedAt: string;
  agentReceipt: {
    adapter: "codex";
    model: string;
    reasoningEffort: (typeof LOCAL_INTAKE_FRONTIER_EFFORTS)[number];
    promptVersion: string;
    repositoryHeads: { tomverse: string; privateDocs: string };
  };
  classification: LocalIntakeClassification;
  recommendation: LocalIntakeRecommendation;
  summary: string;
  questions: string[];
  cards: LocalIntakeCard[];
};

export type LocalIntakeSnapshotCard = {
  id: string;
  title: string;
  status: string;
  priority: string;
  kind: string;
  summary: string;
  dependencyIds: string[];
  sourceDigest: string | null;
};

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

const sameKeys = (value: object, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const bounded = (value: string, max: number): boolean => bytes(value) >= 1 && bytes(value) <= max;

export const localIntakeApplyPermitted = (
  envValue: string | undefined,
  codeLatch: boolean = LOCAL_INTAKE_APPLY_CODE_LATCH,
): boolean => codeLatch === true && envValue === "enabled";

export const localIntakeFrontierAccepted = (model: string, effort: string): boolean =>
  (LOCAL_INTAKE_FRONTIER_MODELS as readonly string[]).includes(model) &&
  (LOCAL_INTAKE_FRONTIER_EFFORTS as readonly string[]).includes(effort);

const controlChar = (value: string): boolean => /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);

const secretPattern = (value: string): boolean =>
  /sk-[A-Za-z0-9]/.test(value) ||
  /ghp_/.test(value) ||
  /github_pat_/.test(value) ||
  /AKIA[0-9A-Z]{16}/.test(value) ||
  /xox[baprs]-/.test(value) ||
  /-----BEGIN /.test(value) ||
  /DATABASE_URL\s*=/.test(value) ||
  /(?:api[_-]?key|secret|password|token)\s*[:=]\s*\S{8,}/i.test(value);

/** v4 is a separate, dark gate. The live v3 scanner above is unchanged. */
const v4SecretPattern = (value: string): boolean =>
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{1,}/.test(value) ||
  /sk_(?:test|live)_[A-Za-z0-9]{12,}/i.test(value) ||
  /rk_(?:test|live)_[A-Za-z0-9]{12,}/i.test(value) ||
  /whsec_[A-Za-z0-9]{12,}/i.test(value) ||
  /ghp_/.test(value) ||
  /github_pat_/.test(value) ||
  /AKIA[0-9A-Z]{16}/.test(value) ||
  /xox[baprs]-/.test(value) ||
  /-----BEGIN /.test(value) ||
  /DATABASE_URL\s*=/.test(value) ||
  /(?:api[\s_-]*key|secret|password|token)\s*[:=]\s*\S{8,}/i.test(value);

const emailPattern = (value: string): boolean => /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(value);

const phonePattern = (value: string): boolean => /\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/.test(value);

const absolutePath = (value: string): boolean =>
  /[A-Za-z]:\\/.test(value) ||
  /\\\\[A-Za-z0-9_.$-]+\\/.test(value) ||
  /(?:^|[\s"'`(])\/(?:Users|home|opt|var|etc|private|root)\//.test(value);

const privateUrl = (value: string): boolean => {
  if (/file:\/\//i.test(value)) return true;
  if (/\blocalhost\b/i.test(value) || /\b127\.0\.0\.1\b/.test(value) || /\b0\.0\.0\.0\b/.test(value)) return true;
  if (/\[::1\]/.test(value) || /\.local\b/i.test(value)) return true;
  if (/\b169\.254\.169\.254\b/.test(value)) return true;
  if (/\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(value)) return true;
  if (/\b192\.168\.\d{1,3}\.\d{1,3}\b/.test(value)) return true;
  if (/\b172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}\b/.test(value)) return true;
  return false;
};

const scanIntakeInputWithSecret = (
  value: string,
  hasSecret: (value: string) => boolean,
): { ok: true } | { ok: false; code: string } => {
  if (typeof value !== "string") return { ok: false, code: "schema_rejected" };
  if (bytes(value) < 1) return { ok: false, code: "metadata_incomplete" };
  if (bytes(value) > LOCAL_INTAKE_INPUT_MAX_BYTES) return { ok: false, code: "too_large" };
  if (controlChar(value)) return { ok: false, code: "control_character" };
  if (hasSecret(value)) return { ok: false, code: "secret" };
  if (emailPattern(value) || phonePattern(value)) return { ok: false, code: "personal_data" };
  if (absolutePath(value)) return { ok: false, code: "absolute_path" };
  if (privateUrl(value)) return { ok: false, code: "private_url" };
  return { ok: true };
};

/** Operator text, before any v3 model process starts. */
export const scanLocalIntakeInput = (value: string): { ok: true } | { ok: false; code: string } =>
  scanIntakeInputWithSecret(value, secretPattern);

/** Separate v4 input gate; this does not change the already enabled v3 path. */
export const scanAmuxV4Input = (value: string): { ok: true } | { ok: false; code: string } =>
  scanIntakeInputWithSecret(value, v4SecretPattern);

const proseRefused = (value: string): string | null => {
  if (controlChar(value)) return "control_character";
  if (secretPattern(value)) return "secret";
  if (emailPattern(value) || phonePattern(value)) return "personal_data";
  if (absolutePath(value)) return "absolute_path";
  if (privateUrl(value) || /https?:\/\//i.test(value)) return "private_url";
  return null;
};

const relativePathRefused = (value: string): boolean =>
  !RELATIVE_PATH_PATTERN.test(value) || value.split("/").includes("..") || bytes(value) > LOCAL_INTAKE_TITLE_MAX_BYTES;

export const localIntakeCardDigest = (card: LocalIntakeCard): string =>
  createHash("sha256")
    .update(`local-amux-intake-card:${LOCAL_INTAKE_CANONICALIZATION_VERSION}\n`, "utf8")
    .update(amuxCanonicalJson(card), "utf8")
    .digest("hex");

export const localIntakePackageDigest = (pkg: LocalIntakePackage): string =>
  createHash("sha256")
    .update(`local-amux-intake-package:${LOCAL_INTAKE_CANONICALIZATION_VERSION}\n`, "utf8")
    .update(amuxCanonicalJson(pkg), "utf8")
    .digest("hex");

export const localIntakeStoredSourceKey = (
  secret: string,
  analysisId: string,
  localId: string,
  digest: string,
): string | null => {
  if (typeof secret !== "string" || bytes(secret) < 32) return null;
  if (!ANALYSIS_ID_PATTERN.test(analysisId) || !LOCAL_ID_PATTERN.test(localId) || !SHA256_PATTERN.test(digest)) {
    return null;
  }
  return createHmac("sha256", secret)
    .update(`${analysisId}\n${localId}\n${digest}`, "utf8")
    .digest("hex")
    .toUpperCase();
};

const stringList = (
  value: unknown,
  cap: number,
  itemMax: number,
): { ok: true; items: string[] } | { ok: false; code: string } => {
  if (!Array.isArray(value) || value.length > cap) return { ok: false, code: "schema_rejected" };
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !bounded(entry, itemMax)) return { ok: false, code: "schema_rejected" };
    const refused = proseRefused(entry);
    if (refused) return { ok: false, code: refused };
    items.push(entry);
  }
  return { ok: true, items };
};

const parseCard = (value: unknown): { ok: true; card: LocalIntakeCard } | { ok: false; code: string } => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "schema_rejected" };
  const record = value as Record<string, unknown>;
  if (!sameKeys(record, CARD_KEYS)) return { ok: false, code: "schema_rejected" };
  if (typeof record.localId !== "string" || !LOCAL_ID_PATTERN.test(record.localId)) {
    return { ok: false, code: "schema_rejected" };
  }
  const texts: Array<[unknown, number]> = [
    [record.title, LOCAL_INTAKE_TITLE_MAX_BYTES],
    [record.problem, LOCAL_INTAKE_TEXT_MAX_BYTES],
    [record.rationale, LOCAL_INTAKE_TEXT_MAX_BYTES],
    [record.priorityRationale, LOCAL_INTAKE_TEXT_MAX_BYTES],
  ];
  for (const [text, max] of texts) {
    if (typeof text !== "string" || !bounded(text, max)) return { ok: false, code: "schema_rejected" };
    const refused = proseRefused(text);
    if (refused) return { ok: false, code: refused };
  }
  const scopeIn = stringList(record.scopeIn, LOCAL_INTAKE_LIST_CAP, LOCAL_INTAKE_ITEM_MAX_BYTES);
  if (!scopeIn.ok) return scopeIn;
  const scopeOut = stringList(record.scopeOut, LOCAL_INTAKE_LIST_CAP, LOCAL_INTAKE_ITEM_MAX_BYTES);
  if (!scopeOut.ok) return scopeOut;
  const acceptance = stringList(record.acceptanceCriteria, LOCAL_INTAKE_LIST_CAP, LOCAL_INTAKE_ITEM_MAX_BYTES);
  if (!acceptance.ok) return acceptance;
  const evidence = stringList(record.evidence, LOCAL_INTAKE_LIST_CAP, LOCAL_INTAKE_ITEM_MAX_BYTES);
  if (!evidence.ok) return evidence;
  const risks = stringList(record.risks, LOCAL_INTAKE_LIST_CAP, LOCAL_INTAKE_ITEM_MAX_BYTES);
  if (!risks.ok) return risks;
  const dependencies = stringList(record.dependencyIds, LOCAL_INTAKE_DEPENDENCY_CAP, LOCAL_INTAKE_TITLE_MAX_BYTES);
  if (!dependencies.ok) return dependencies;
  const duplicates = stringList(record.duplicateCandidateIds, LOCAL_INTAKE_DUPLICATE_CAP, LOCAL_INTAKE_TITLE_MAX_BYTES);
  if (!duplicates.ok) return duplicates;
  if (!Array.isArray(record.repositoryPaths) || record.repositoryPaths.length > LOCAL_INTAKE_PATH_CAP) {
    return { ok: false, code: "schema_rejected" };
  }
  for (const path of record.repositoryPaths) {
    if (typeof path !== "string" || relativePathRefused(path)) return { ok: false, code: "absolute_path" };
  }
  if (typeof record.priority !== "string" || !(LOCAL_INTAKE_PRIORITIES as readonly string[]).includes(record.priority)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (typeof record.kindProposal !== "string" || !(LOCAL_INTAKE_KINDS as readonly string[]).includes(record.kindProposal)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (typeof record.estimatedSize !== "string" || !(LOCAL_INTAKE_SIZES as readonly string[]).includes(record.estimatedSize)) {
    return { ok: false, code: "schema_rejected" };
  }
  return {
    ok: true,
    card: {
      localId: record.localId,
      title: record.title as string,
      problem: record.problem as string,
      rationale: record.rationale as string,
      scopeIn: scopeIn.items,
      scopeOut: scopeOut.items,
      acceptanceCriteria: acceptance.items,
      evidence: evidence.items,
      priority: record.priority as LocalIntakePriority,
      priorityRationale: record.priorityRationale as string,
      kindProposal: record.kindProposal as LocalIntakeKind,
      repositoryPaths: record.repositoryPaths as string[],
      dependencyIds: dependencies.items,
      duplicateCandidateIds: duplicates.items,
      risks: risks.items,
      estimatedSize: record.estimatedSize as LocalIntakeSize,
    },
  };
};

const hasCycle = (cards: readonly LocalIntakeCard[]): boolean => {
  const ids = new Set(cards.map((card) => card.localId));
  const edges = new Map(cards.map((card) => [card.localId, card.dependencyIds.filter((item) => ids.has(item))]));
  const state = new Map<string, "open" | "done">();
  const visit = (id: string): boolean => {
    const mark = state.get(id);
    if (mark === "open") return true;
    if (mark === "done") return false;
    state.set(id, "open");
    for (const next of edges.get(id) ?? []) {
      if (visit(next)) return true;
    }
    state.set(id, "done");
    return false;
  };
  return [...ids].some((id) => visit(id));
};

export const parseLocalIntakePackage = (
  raw: string,
): { ok: true; pkg: LocalIntakePackage } | { ok: false; code: string } => {
  if (typeof raw !== "string" || bytes(raw) > LOCAL_INTAKE_PACKAGE_MAX_BYTES) return { ok: false, code: "too_large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, code: "schema_rejected" };
  const record = parsed as Record<string, unknown>;
  if (!sameKeys(record, PACKAGE_KEYS)) return { ok: false, code: "schema_rejected" };
  if (record.schemaVersion !== LOCAL_INTAKE_SCHEMA_VERSION) return { ok: false, code: "schema_rejected" };
  if (typeof record.analysisId !== "string" || !ANALYSIS_ID_PATTERN.test(record.analysisId)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (typeof record.inputDigest !== "string" || !SHA256_PATTERN.test(record.inputDigest)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (typeof record.boardSnapshotDigest !== "string" || !SHA256_PATTERN.test(record.boardSnapshotDigest)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (typeof record.snapshotGeneratedAt !== "string" || !ISO_PATTERN.test(record.snapshotGeneratedAt)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (typeof record.generatedAt !== "string" || !ISO_PATTERN.test(record.generatedAt)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (!record.agentReceipt || typeof record.agentReceipt !== "object" || Array.isArray(record.agentReceipt)) {
    return { ok: false, code: "schema_rejected" };
  }
  const receipt = record.agentReceipt as Record<string, unknown>;
  if (!sameKeys(receipt, RECEIPT_KEYS)) return { ok: false, code: "schema_rejected" };
  if (receipt.adapter !== "codex") return { ok: false, code: "schema_rejected" };
  if (typeof receipt.model !== "string" || typeof receipt.reasoningEffort !== "string") {
    return { ok: false, code: "schema_rejected" };
  }
  if (!localIntakeFrontierAccepted(receipt.model, receipt.reasoningEffort)) {
    return { ok: false, code: "frontier_model_unavailable" };
  }
  if (receipt.promptVersion !== LOCAL_INTAKE_PROMPT_VERSION) return { ok: false, code: "schema_rejected" };
  if (!receipt.repositoryHeads || typeof receipt.repositoryHeads !== "object" || Array.isArray(receipt.repositoryHeads)) {
    return { ok: false, code: "schema_rejected" };
  }
  const heads = receipt.repositoryHeads as Record<string, unknown>;
  if (!sameKeys(heads, HEAD_KEYS)) return { ok: false, code: "schema_rejected" };
  if (typeof heads.tomverse !== "string" || !GIT_SHA_PATTERN.test(heads.tomverse)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (typeof heads.privateDocs !== "string" || !GIT_SHA_PATTERN.test(heads.privateDocs)) {
    return { ok: false, code: "schema_rejected" };
  }
  if (
    typeof record.classification !== "string" ||
    !(LOCAL_INTAKE_CLASSIFICATIONS as readonly string[]).includes(record.classification)
  ) {
    return { ok: false, code: "schema_rejected" };
  }
  if (
    typeof record.recommendation !== "string" ||
    !(LOCAL_INTAKE_RECOMMENDATIONS as readonly string[]).includes(record.recommendation)
  ) {
    return { ok: false, code: "schema_rejected" };
  }
  if (typeof record.summary !== "string" || !bounded(record.summary, LOCAL_INTAKE_TEXT_MAX_BYTES)) {
    return { ok: false, code: "schema_rejected" };
  }
  const summaryRefused = proseRefused(record.summary);
  if (summaryRefused) return { ok: false, code: summaryRefused };
  const questions = stringList(record.questions, LOCAL_INTAKE_QUESTION_CAP, LOCAL_INTAKE_ITEM_MAX_BYTES);
  if (!questions.ok) return questions;
  if (!Array.isArray(record.cards) || record.cards.length < 1 || record.cards.length > LOCAL_INTAKE_CARD_CAP) {
    return { ok: false, code: record.cards && Array.isArray(record.cards) && record.cards.length > LOCAL_INTAKE_CARD_CAP ? "card_cap_exceeded" : "schema_rejected" };
  }
  const cards: LocalIntakeCard[] = [];
  for (const entry of record.cards) {
    const card = parseCard(entry);
    if (!card.ok) return card;
    cards.push(card.card);
  }
  if (new Set(cards.map((card) => card.localId)).size !== cards.length) return { ok: false, code: "schema_rejected" };
  return {
    ok: true,
    pkg: {
      schemaVersion: LOCAL_INTAKE_SCHEMA_VERSION,
      analysisId: record.analysisId,
      inputDigest: record.inputDigest,
      boardSnapshotDigest: record.boardSnapshotDigest,
      snapshotGeneratedAt: record.snapshotGeneratedAt,
      generatedAt: record.generatedAt,
      agentReceipt: {
        adapter: "codex",
        model: receipt.model,
        reasoningEffort: receipt.reasoningEffort as LocalIntakePackage["agentReceipt"]["reasoningEffort"],
        promptVersion: LOCAL_INTAKE_PROMPT_VERSION,
        repositoryHeads: { tomverse: heads.tomverse, privateDocs: heads.privateDocs },
      },
      classification: record.classification as LocalIntakeClassification,
      recommendation: record.recommendation as LocalIntakeRecommendation,
      summary: record.summary,
      questions: questions.items,
      cards,
    },
  };
};

const structuralRefusal = (pkg: LocalIntakePackage): string | null => {
  if (hasCycle(pkg.cards)) return "dependency_cycle";
  const single = pkg.classification === "bug" || pkg.classification === "improvement" || pkg.classification === "production_error";
  if (single && pkg.cards.length !== 1) return "unnecessary_split";
  if (pkg.classification === "production_error") {
    const card = pkg.cards[0];
    if (!card || card.evidence.length < 1 || card.acceptanceCriteria.length < 1) return "evidence_required";
  }
  for (const card of pkg.cards) {
    if ((card.priority === "p0" || card.priority === "p1") && bytes(card.priorityRationale) < 40) {
      return "priority_ungrounded";
    }
    if (card.scopeIn.length < 1 || card.scopeOut.length < 1 || card.acceptanceCriteria.length < 1) {
      return "metadata_incomplete";
    }
  }
  if (pkg.recommendation === "new_cards" && pkg.cards.some((card) => card.duplicateCandidateIds.length > 0)) {
    return "duplicate_unresolved";
  }
  if (pkg.recommendation === "possible_duplicate" && pkg.cards.every((card) => card.duplicateCandidateIds.length === 0)) {
    return "metadata_incomplete";
  }
  if (pkg.recommendation === "needs_information" && pkg.questions.length < 1) return "metadata_incomplete";
  return null;
};

export type LocalIntakeInspection =
  | { ok: false; code: string; writes: 0 }
  | {
      ok: true;
      writes: 0;
      registerable: boolean;
      code: string | null;
      pkg: LocalIntakePackage;
      digests: Record<string, string>;
    };

export const inspectLocalIntakePackage = (
  raw: string,
  input: { now: Date; liveSnapshotDigest: string },
): LocalIntakeInspection => {
  const parsed = parseLocalIntakePackage(raw);
  if (!parsed.ok) return { ok: false, code: parsed.code, writes: 0 };
  const structural = structuralRefusal(parsed.pkg);
  if (structural) return { ok: false, code: structural, writes: 0 };
  const snapshotAt = Date.parse(parsed.pkg.snapshotGeneratedAt);
  if (!Number.isFinite(snapshotAt) || input.now.getTime() - snapshotAt > LOCAL_INTAKE_SNAPSHOT_MAX_AGE_MS) {
    return { ok: false, code: "snapshot_stale", writes: 0 };
  }
  if (parsed.pkg.boardSnapshotDigest !== input.liveSnapshotDigest) {
    return { ok: false, code: "snapshot_digest_mismatch", writes: 0 };
  }
  const registerable = parsed.pkg.recommendation === "new_cards";
  const digests: Record<string, string> = {};
  for (const card of parsed.pkg.cards) digests[card.localId] = localIntakeCardDigest(card);
  return {
    ok: true,
    writes: 0,
    registerable,
    code: registerable ? null : parsed.pkg.recommendation,
    pkg: parsed.pkg,
    digests,
  };
};

const utf8Prefix = (value: string, max: number): string => {
  let size = 0;
  let end = 0;
  for (const char of value) {
    const next = size + Buffer.byteLength(char, "utf8");
    if (next > max) break;
    size = next;
    end += char.length;
  }
  return value.slice(0, end);
};

export const buildLocalIntakeSnapshot = (
  cards: readonly LocalIntakeSnapshotCard[],
  generatedAt: string,
): { ok: true; generatedAt: string; digest: string; cards: LocalIntakeSnapshotCard[] } | { ok: false; code: string } => {
  if (!ISO_PATTERN.test(generatedAt)) return { ok: false, code: "schema_rejected" };
  if (cards.length > 256) return { ok: false, code: "snapshot_too_large" };
  const normalized = [...cards]
    .map((card) => ({
      id: card.id,
      title: utf8Prefix(card.title, LOCAL_INTAKE_TITLE_MAX_BYTES),
      status: card.status,
      priority: card.priority,
      kind: card.kind,
      summary: utf8Prefix(card.summary || card.title, LOCAL_INTAKE_TITLE_MAX_BYTES),
      dependencyIds: [...card.dependencyIds].sort(),
      sourceDigest: card.sourceDigest,
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  for (const card of normalized) {
    if (proseRefused(card.title) || proseRefused(card.summary)) return { ok: false, code: "content_refused" };
    if (card.sourceDigest !== null && !SHA256_PATTERN.test(card.sourceDigest)) return { ok: false, code: "schema_rejected" };
  }
  const digest = createHash("sha256")
    .update(`local-amux-intake-snapshot:${LOCAL_INTAKE_CANONICALIZATION_VERSION}\n`, "utf8")
    .update(amuxCanonicalJson(normalized), "utf8")
    .digest("hex");
  return { ok: true, generatedAt, digest, cards: normalized };
};

export const localIntakeMayRegisterNext = (
  previous: "committed" | "absent" | "partial" | "outcome_unknown" | null,
): boolean => previous === null || previous === "committed" || previous === "absent";
