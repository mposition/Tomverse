import { createHash, createHmac } from "node:crypto";

import {
  AMUX_MANIFEST_CANONICALIZATION_VERSION,
  amuxCanonicalJson,
  amuxCatalogTextRefused,
  boardImportApplyPermitted,
} from "./boardImportCore.ts";

/**
 * Manual intake of one explicit Codex registration.
 *
 * docs/policy/amux-intake.md (policy version 1).
 *
 * Parsing and the guard are pure. This module does not open a transaction,
 * write an audit row, or create a card. Production apply needs both latches.
 * Version 1 ships the code latch false. Nothing here calls a provider or
 * spends credits.
 */

export const AMUX_INTAKE_POLICY_VERSION = 1;
export const AMUX_INTAKE_AGENT_ID = "amux-intake";
export const AMUX_INTAKE_SOURCE_SYSTEM = "codex-conversation";
export const AMUX_INTAKE_CANONICALIZATION_VERSION = AMUX_MANIFEST_CANONICALIZATION_VERSION;
export const AMUX_INTAKE_APPLY_ENV = "TOMVERSE_AMUX_INTAKE_APPLY";
export const AMUX_INTAKE_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
export const AMUX_INTAKE_APPROVAL_TTL_MS = 15 * 60 * 1000;
export const AMUX_INTAKE_RAW_BODY_MAX_BYTES = 16_384;
export const AMUX_INTAKE_TITLE_MAX_BYTES = 200;
export const AMUX_INTAKE_TEXT_MAX_BYTES = 2_000;

/**
 * Second apply latch. One environment variable must not be enough to create
 * a card. The shipped constant is false.
 */
export const AMUX_INTAKE_APPLY_CODE_LATCH = false;

export const AMUX_INTAKE_PRIORITIES = ["p0", "p1", "p2", "p3"] as const;

const REQUEST_KEYS = [
  "canonicalizationVersion",
  "explicitRegistration",
  "policyVersion",
  "proposal",
  "sourceTaskId",
  "workItem",
] as const;
const REQUEST_KEYS_WITH_CONFIRMATION = [...REQUEST_KEYS, "confirmationDigest"] as const;
const PROPOSAL_KEYS = ["completion", "priority", "scope", "title"] as const;
const WORK_ITEM_KEYS = ["digest", "id", "version"] as const;

const WORK_ITEM_ID_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,63}$/;
const VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type AmuxIntakePriority = (typeof AMUX_INTAKE_PRIORITIES)[number];

export type AmuxIntakeWorkItemRef = {
  id: string;
  version: string;
  digest: string;
};

export type AmuxIntakeProposal = {
  title: string;
  scope: string;
  completion: string;
  priority: AmuxIntakePriority;
};

export type AmuxIntakeDraft = {
  canonicalizationVersion: typeof AMUX_INTAKE_CANONICALIZATION_VERSION;
  policyVersion: typeof AMUX_INTAKE_POLICY_VERSION;
  explicitRegistration: true;
  sourceTaskId: string;
  workItem: AmuxIntakeWorkItemRef | null;
  proposal: AmuxIntakeProposal;
  confirmationDigest?: string;
};

export type AmuxIntakeNormalizedDraft = {
  policyVersion: typeof AMUX_INTAKE_POLICY_VERSION;
  priority: AmuxIntakePriority;
  title: string;
  scope: string;
  completion: string;
  workItem: AmuxIntakeWorkItemRef | null;
};

export type AmuxIntakeCardPlan = {
  status: "backlog";
  kind: "unknown";
  priority: AmuxIntakePriority;
  owner: null;
  claimedAt: null;
  sourceSystem: typeof AMUX_INTAKE_SOURCE_SYSTEM;
  agentId: typeof AMUX_INTAKE_AGENT_ID;
  executionBrief: null;
  draftDigest: string;
};

export type AmuxIntakeGuard =
  | { outcome: "reject"; code: string; card: null }
  | { outcome: "approval_required"; code: null; draftDigest: string; card: null }
  | { outcome: "allow"; code: null; draftDigest: string; card: AmuxIntakeCardPlan };

const sameKeys = (value: object, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

const taskIdRefused = (value: string): boolean => {
  if (bytes(value) < 1 || bytes(value) > 200) return true;
  return /[\u0000-\u001f\\/]/.test(value);
};

const scannedText = (value: string, maxBytes: number): boolean =>
  bytes(value) >= 1 &&
  bytes(value) <= maxBytes &&
  !amuxCatalogTextRefused(value);

export const amuxIntakeApplyPermitted = boardImportApplyPermitted;

export const amuxIntakeNormalizedDraft = (draft: AmuxIntakeDraft): AmuxIntakeNormalizedDraft => ({
  policyVersion: draft.policyVersion,
  priority: draft.proposal.priority,
  title: draft.proposal.title,
  scope: draft.proposal.scope,
  completion: draft.proposal.completion,
  workItem: draft.workItem,
});

export const amuxIntakeDraftDigest = (draft: AmuxIntakeDraft): string =>
  createHash("sha256")
    .update(`amux-intake-draft:${AMUX_INTAKE_CANONICALIZATION_VERSION}\n`, "utf8")
    .update(amuxCanonicalJson(amuxIntakeNormalizedDraft(draft)), "utf8")
    .digest("hex");

/** Returns null when the secret or the task id cannot produce a key. The raw id is not returned. */
export const amuxIntakeSourceKey = (secret: string, sourceTaskId: string): string | null => {
  if (typeof secret !== "string" || bytes(secret) < 32) return null;
  if (typeof sourceTaskId !== "string" || taskIdRefused(sourceTaskId)) return null;
  return createHmac("sha256", secret).update(sourceTaskId, "utf8").digest("hex");
};

const workItemRefused = (value: unknown): string | null => {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "schema_rejected";
  const record = value as Record<string, unknown>;
  if (!sameKeys(record, WORK_ITEM_KEYS)) return "schema_rejected";
  if (typeof record.id !== "string" || !WORK_ITEM_ID_PATTERN.test(record.id)) return "schema_rejected";
  if (typeof record.version !== "string" || !VERSION_PATTERN.test(record.version)) return "schema_rejected";
  if (typeof record.digest !== "string" || !SHA256_PATTERN.test(record.digest)) return "schema_rejected";
  if (amuxCatalogTextRefused(record.id) || amuxCatalogTextRefused(record.version)) return "content_refused";
  return null;
};

const proposalRefused = (value: unknown, sourceTaskId: string): string | null => {
  if (Array.isArray(value)) return "multiple_units";
  if (!value || typeof value !== "object") return "schema_rejected";
  const record = value as Record<string, unknown>;
  if (!sameKeys(record, PROPOSAL_KEYS)) return "schema_rejected";
  if (
    typeof record.title !== "string" ||
    typeof record.scope !== "string" ||
    typeof record.completion !== "string"
  ) {
    return "metadata_incomplete";
  }
  if (!scannedText(record.title, AMUX_INTAKE_TITLE_MAX_BYTES)) return "content_refused";
  if (!scannedText(record.scope, AMUX_INTAKE_TEXT_MAX_BYTES)) return "content_refused";
  if (!scannedText(record.completion, AMUX_INTAKE_TEXT_MAX_BYTES)) return "content_refused";
  if (
    record.title.includes(sourceTaskId) ||
    record.scope.includes(sourceTaskId) ||
    record.completion.includes(sourceTaskId)
  ) {
    return "source_id_echo";
  }
  if (typeof record.priority !== "string" || !AMUX_INTAKE_PRIORITIES.includes(record.priority as AmuxIntakePriority)) {
    return "priority_not_explicit";
  }
  return null;
};

export const parseAmuxIntakeDraft = (
  raw: string,
): { ok: true; draft: AmuxIntakeDraft } | { ok: false; code: string } => {
  if (bytes(raw) > AMUX_INTAKE_RAW_BODY_MAX_BYTES) return { ok: false, code: "too_large" };
  // Scan stored strings after parse. The catalog scanner matches `sk-` inside
  // ordinary words, and a work-item digest is 64 hex, so the raw JSON is not
  // one scanned string.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "schema_rejected" };
  }
  const record = parsed as Record<string, unknown>;
  if ("proposals" in record || Array.isArray(record.proposal)) return { ok: false, code: "multiple_units" };
  if (record.explicitRegistration !== true) return { ok: false, code: "implicit_registration" };
  const withConfirmation = Object.hasOwn(record, "confirmationDigest");
  const keys = withConfirmation ? REQUEST_KEYS_WITH_CONFIRMATION : REQUEST_KEYS;
  if (!sameKeys(record, keys)) return { ok: false, code: "schema_rejected" };
  if (record.canonicalizationVersion !== AMUX_INTAKE_CANONICALIZATION_VERSION) {
    return { ok: false, code: "schema_rejected" };
  }
  if (record.policyVersion !== AMUX_INTAKE_POLICY_VERSION) return { ok: false, code: "schema_rejected" };
  if (typeof record.sourceTaskId !== "string" || taskIdRefused(record.sourceTaskId)) {
    return { ok: false, code: "schema_rejected" };
  }
  const workItemCode = workItemRefused(record.workItem);
  if (workItemCode) return { ok: false, code: workItemCode };
  const proposalCode = proposalRefused(record.proposal, record.sourceTaskId);
  if (proposalCode) return { ok: false, code: proposalCode };
  if (withConfirmation && (typeof record.confirmationDigest !== "string" || !SHA256_PATTERN.test(record.confirmationDigest))) {
    return { ok: false, code: "schema_rejected" };
  }
  const proposal = record.proposal as AmuxIntakeProposal;
  return {
    ok: true,
    draft: {
      canonicalizationVersion: AMUX_INTAKE_CANONICALIZATION_VERSION,
      policyVersion: AMUX_INTAKE_POLICY_VERSION,
      explicitRegistration: true,
      sourceTaskId: record.sourceTaskId,
      workItem: record.workItem as AmuxIntakeWorkItemRef | null,
      proposal: {
        title: proposal.title,
        scope: proposal.scope,
        completion: proposal.completion,
        priority: proposal.priority,
      },
      ...(withConfirmation ? { confirmationDigest: record.confirmationDigest as string } : {}),
    },
  };
};

export const guardAmuxIntake = (
  raw: string,
  storedDraftDigest: string | null = null,
): AmuxIntakeGuard => {
  const parsed = parseAmuxIntakeDraft(raw);
  if (!parsed.ok) return { outcome: "reject", code: parsed.code, card: null };
  const draftDigest = amuxIntakeDraftDigest(parsed.draft);
  if (storedDraftDigest !== null && storedDraftDigest !== draftDigest) {
    return { outcome: "reject", code: "conflict", card: null };
  }
  if (!parsed.draft.confirmationDigest) {
    return { outcome: "approval_required", code: null, draftDigest, card: null };
  }
  if (parsed.draft.confirmationDigest !== draftDigest) {
    return { outcome: "reject", code: "digest_mismatch", card: null };
  }
  return {
    outcome: "allow",
    code: null,
    draftDigest,
    card: {
      status: "backlog",
      kind: "unknown",
      priority: parsed.draft.proposal.priority,
      owner: null,
      claimedAt: null,
      sourceSystem: AMUX_INTAKE_SOURCE_SYSTEM,
      agentId: AMUX_INTAKE_AGENT_ID,
      executionBrief: null,
      draftDigest,
    },
  };
};
