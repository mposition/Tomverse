import { BOARD_IMPORT_SCANNER_VERSION } from "./boardImportCore.ts";
import {
  AMUX_INTAKE_AGENT_ID,
  AMUX_INTAKE_POLICY_VERSION,
  AMUX_INTAKE_SOURCE_SYSTEM,
  type AmuxIntakePriority,
  amuxIntakeApplyPermitted,
  amuxIntakeDraftDigest,
  amuxIntakeStoredSourceKey,
  guardAmuxIntake,
  parseAmuxIntakeDraft,
} from "./intakeCore.ts";

/**
 * Preview and the registration plan for one explicit intake.
 *
 * docs/policy/amux-intake.md (policy version 1).
 *
 * Preview writes nothing. The plan names the one transaction that creates a
 * backlog card, a body-free draft, a consumed approval and one human audit
 * row. It does not name a todo transition, an owner, a claim, an attempt, a
 * delivery, a route decision, a provider cost or a user credit.
 */

export const AMUX_INTAKE_DRAFT_STATUSES = ["consumed", "rejected", "expired"] as const;
export const AMUX_INTAKE_APPROVAL_STATUSES = ["consumed", "outcome_unknown"] as const;
export const AMUX_INTAKE_SOURCE_KEY_SECRET_ENV = "AMUX_INTAKE_SOURCE_KEY_SECRET";

/** Four responsibilities. One operator holds all four until a second person exists. */
export const AMUX_INTAKE_DRIFT_OWNERS = {
  detailDocument: "mposition",
  cardRevision: "mposition",
  reconciliation: "mposition",
  governanceCutover: "mposition",
} as const;

export const AMUX_INTAKE_UNTOUCHED_TABLES = [
  "AmuxExecutionAttempt",
  "AmuxWorkDelivery",
  "AmuxRouteDecision",
  "AmuxCostLedgerEntry",
  "CreditLot",
  "CreditLedgerEntry",
  "CreditPurchase",
  "CreditDebtEntry",
] as const;

const STORED_SOURCE_KEY = /^[A-Z0-9][A-Z0-9._:-]*$/;

export type AmuxIntakePreview = {
  outcome: "reject" | "approval_required" | "allow";
  code: string | null;
  unitCount: 0 | 1;
  inactive: boolean;
  applyPermitted: boolean;
  writes: 0;
  reconfirmRequired: boolean;
  title: string | null;
  scope: string | null;
  completion: string | null;
  priority: AmuxIntakePriority | null;
  sourceVersion: string | null;
  sourceDigest: string | null;
  draftDigest: string | null;
  sourceKey: string | null;
  workItem: { id: string; version: string; digest: string } | null;
};

export type AmuxIntakeCardWrite = {
  title: string;
  description: null;
  status: "backlog";
  kind: "unknown";
  priority: AmuxIntakePriority;
  owner: null;
  claimedAt: null;
  pinned: false;
  drag: 0;
  revision: 0;
  sourceSystem: typeof AMUX_INTAKE_SOURCE_SYSTEM;
  sourceKey: string;
  sourceVersion: string;
  sourceDigest: string;
  sourceSnapshot: {
    agentId: typeof AMUX_INTAKE_AGENT_ID;
    policyVersion: typeof AMUX_INTAKE_POLICY_VERSION;
    draftDigest: string;
    priority: AmuxIntakePriority;
    workItemId: string | null;
    workItemVersion: string | null;
    workItemDigest: string | null;
  };
  executionBrief: null;
  executionBriefDigest: null;
};

export type AmuxIntakeAuditMetadata = {
  policyVersion: typeof AMUX_INTAKE_POLICY_VERSION;
  draftDigest: string;
  sourceDigest: string;
  cardCount: 1;
  scannerVersion: typeof BOARD_IMPORT_SCANNER_VERSION;
};

export type AmuxIntakeRegistrationPlan = {
  card: AmuxIntakeCardWrite;
  draftStatus: "consumed";
  approvalStatus: "consumed";
  auditAction: "amux.intake.consumed";
  audit: AmuxIntakeAuditMetadata;
  untouched: typeof AMUX_INTAKE_UNTOUCHED_TABLES;
};

export type AmuxIntakeDriftReport = {
  kind: "same" | "conflict";
  storedDigest: string;
  observedDigest: string;
  dropped: false;
  owners: typeof AMUX_INTAKE_DRIFT_OWNERS;
};

const emptyPreview = (
  code: string,
  inactive = true,
): AmuxIntakePreview => ({
  outcome: "reject",
  code,
  unitCount: 0,
  inactive,
  applyPermitted: false,
  writes: 0,
  reconfirmRequired: false,
  title: null,
  scope: null,
  completion: null,
  priority: null,
  sourceVersion: null,
  sourceDigest: null,
  draftDigest: null,
  sourceKey: null,
  workItem: null,
});

export const previewAmuxIntake = (
  raw: string,
  secret: string | null,
  envValue: string | undefined,
): AmuxIntakePreview => {
  const parsed = parseAmuxIntakeDraft(raw);
  if (!parsed.ok) return emptyPreview(parsed.code, !amuxIntakeApplyPermitted(envValue));
  const guarded = guardAmuxIntake(raw);
  const draftDigest = amuxIntakeDraftDigest(parsed.draft);
  const sourceKey = secret === null ? null : amuxIntakeStoredSourceKey(secret, parsed.draft.sourceTaskId);
  const latchOpen = amuxIntakeApplyPermitted(envValue);
  const shown: AmuxIntakePreview = {
    outcome: guarded.outcome,
    code: guarded.outcome === "reject" ? guarded.code : null,
    unitCount: 1,
    inactive: !latchOpen,
    applyPermitted: latchOpen && guarded.outcome === "allow" && sourceKey !== null,
    writes: 0,
    reconfirmRequired: guarded.outcome !== "allow",
    title: parsed.draft.proposal.title,
    scope: parsed.draft.proposal.scope,
    completion: parsed.draft.proposal.completion,
    priority: parsed.draft.proposal.priority,
    sourceVersion: parsed.draft.workItem?.version ?? "policy-1",
    sourceDigest: draftDigest,
    draftDigest,
    sourceKey,
    workItem: parsed.draft.workItem,
  };
  if (guarded.outcome === "reject" && guarded.code !== "digest_mismatch") return emptyPreview(guarded.code, !latchOpen);
  return shown;
};

export const planAmuxIntakeRegistration = (
  raw: string,
  secret: string | null,
): { ok: true; plan: AmuxIntakeRegistrationPlan } | { ok: false; code: string; writes: 0 } => {
  const preview = previewAmuxIntake(raw, secret, undefined);
  if (preview.outcome !== "allow" || preview.sourceKey === null || preview.draftDigest === null) {
    return { ok: false, code: preview.code ?? "approval_required", writes: 0 };
  }
  if (!STORED_SOURCE_KEY.test(preview.sourceKey)) return { ok: false, code: "schema_rejected", writes: 0 };
  const priority = preview.priority;
  const sourceVersion = preview.sourceVersion;
  if (priority === null || sourceVersion === null || preview.title === null) {
    return { ok: false, code: "metadata_incomplete", writes: 0 };
  }
  const card: AmuxIntakeCardWrite = {
    title: preview.title,
    description: null,
    status: "backlog",
    kind: "unknown",
    priority,
    owner: null,
    claimedAt: null,
    pinned: false,
    drag: 0,
    revision: 0,
    sourceSystem: AMUX_INTAKE_SOURCE_SYSTEM,
    sourceKey: preview.sourceKey,
    sourceVersion,
    sourceDigest: preview.draftDigest,
    sourceSnapshot: {
      agentId: AMUX_INTAKE_AGENT_ID,
      policyVersion: AMUX_INTAKE_POLICY_VERSION,
      draftDigest: preview.draftDigest,
      priority,
      workItemId: preview.workItem?.id ?? null,
      workItemVersion: preview.workItem?.version ?? null,
      workItemDigest: preview.workItem?.digest ?? null,
    },
    executionBrief: null,
    executionBriefDigest: null,
  };
  return {
    ok: true,
    plan: {
      card,
      draftStatus: "consumed",
      approvalStatus: "consumed",
      auditAction: "amux.intake.consumed",
      audit: {
        policyVersion: AMUX_INTAKE_POLICY_VERSION,
        draftDigest: preview.draftDigest,
        sourceDigest: preview.draftDigest,
        cardCount: 1,
        scannerVersion: BOARD_IMPORT_SCANNER_VERSION,
      },
      untouched: AMUX_INTAKE_UNTOUCHED_TABLES,
    },
  };
};

/** Keeps both digests. A conflict does not overwrite the stored card. */
export const reportAmuxIntakeDrift = (
  storedDigest: string,
  observedDigest: string,
): AmuxIntakeDriftReport => ({
  kind: storedDigest === observedDigest ? "same" : "conflict",
  storedDigest,
  observedDigest,
  dropped: false,
  owners: AMUX_INTAKE_DRIFT_OWNERS,
});
