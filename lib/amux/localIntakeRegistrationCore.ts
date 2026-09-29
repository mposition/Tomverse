import {
  LOCAL_INTAKE_AGENT_ID,
  LOCAL_INTAKE_APPLY_CODE_LATCH,
  LOCAL_INTAKE_POLICY_VERSION,
  LOCAL_INTAKE_SCANNER_VERSION,
  LOCAL_INTAKE_SCHEMA_VERSION,
  LOCAL_INTAKE_SOURCE_SYSTEM,
  type LocalIntakeCard,
  type LocalIntakePriority,
  inspectLocalIntakePackage,
  localIntakeApplyPermitted,
  localIntakeCardDigest,
  localIntakePackageDigest,
  localIntakeStoredSourceKey,
} from "./localIntakeCore.ts";

/**
 * One-card registration plan for a local analysis package.
 *
 * docs/policy/amux-intake.md (policy version 3).
 *
 * A package may describe several cards. This plan names one of them. It does
 * not name a dependency row, a todo transition, an owner, a claim, an attempt,
 * a delivery, a route decision, a provider cost or a user credit.
 */

export const LOCAL_INTAKE_UNTOUCHED_TABLES = [
  "AmuxWorkDependency",
  "AmuxExecutionAttempt",
  "AmuxWorkDelivery",
  "AmuxRouteDecision",
  "AmuxCostLedgerEntry",
  "CreditLot",
  "CreditLedgerEntry",
  "CreditPurchase",
  "CreditDebtEntry",
] as const;

export type LocalIntakeCardWrite = {
  title: string;
  description: null;
  status: "backlog";
  kind: "unknown";
  priority: LocalIntakePriority;
  owner: null;
  claimedAt: null;
  pinned: false;
  drag: 0;
  revision: 0;
  sourceSystem: typeof LOCAL_INTAKE_SOURCE_SYSTEM;
  sourceKey: string;
  sourceVersion: "policy-3";
  sourceDigest: string;
  sourceSnapshot: {
    agentId: typeof LOCAL_INTAKE_AGENT_ID;
    policyVersion: typeof LOCAL_INTAKE_POLICY_VERSION;
    schemaVersion: typeof LOCAL_INTAKE_SCHEMA_VERSION;
    draftDigest: string;
    packageDigest: string;
    snapshotDigest: string;
    priority: LocalIntakePriority;
    localId: string;
  };
  executionBrief: null;
  executionBriefDigest: null;
  normalized: LocalIntakeCard;
  createsDependencyRows: false;
};

export type LocalIntakeAuditMetadata = {
  policyVersion: typeof LOCAL_INTAKE_POLICY_VERSION;
  schemaVersion: typeof LOCAL_INTAKE_SCHEMA_VERSION;
  scannerVersion: typeof LOCAL_INTAKE_SCANNER_VERSION;
  draftDigest: string;
  packageDigest: string;
  snapshotDigest: string;
  cardCount: 1;
  sourceSystem: typeof LOCAL_INTAKE_SOURCE_SYSTEM;
};

export type LocalIntakeRegistrationPlan = {
  card: LocalIntakeCardWrite;
  approvalStatus: "consumed";
  auditAction: "amux.local_intake.consumed";
  audit: LocalIntakeAuditMetadata;
  untouched: typeof LOCAL_INTAKE_UNTOUCHED_TABLES;
};

export type LocalIntakeCardPreview = {
  outcome: "reject" | "approval_required" | "allow";
  code: string | null;
  writes: 0;
  applyPermitted: boolean;
  reconfirmRequired: boolean;
  digest: string | null;
  plan: LocalIntakeRegistrationPlan | null;
};

const emptyPreview = (code: string): LocalIntakeCardPreview => ({
  outcome: "reject",
  code,
  writes: 0,
  applyPermitted: false,
  reconfirmRequired: false,
  digest: null,
  plan: null,
});

export const previewLocalIntakeCard = (
  raw: string,
  input: {
    now: Date;
    liveSnapshotDigest: string;
    localId: string;
    confirmationDigest?: string;
    secret: string | null;
    existingIds: readonly string[];
    envValue: string | undefined;
    codeLatch?: boolean;
  },
): LocalIntakeCardPreview => {
  const inspected = inspectLocalIntakePackage(raw, input);
  if (!inspected.ok) return emptyPreview(inspected.code);
  if (!inspected.registerable) return emptyPreview(inspected.code ?? "recommendation_blocked");
  const card = inspected.pkg.cards.find((item) => item.localId === input.localId);
  if (!card) return emptyPreview("schema_rejected");
  const digest = localIntakeCardDigest(card);
  if (inspected.digests[card.localId] !== digest) return emptyPreview("digest_mismatch");
  const existing = new Set(input.existingIds);
  for (const dependency of card.dependencyIds) {
    if (!existing.has(dependency)) {
      return {
        ...emptyPreview(dependency.startsWith("card-") ? "dependency_unresolved" : "dependency_missing"),
        digest,
        reconfirmRequired: true,
      };
    }
  }
  const latch = input.codeLatch ?? LOCAL_INTAKE_APPLY_CODE_LATCH;
  if (!input.confirmationDigest) {
    return {
      outcome: "approval_required",
      code: null,
      writes: 0,
      applyPermitted: false,
      reconfirmRequired: true,
      digest,
      plan: null,
    };
  }
  if (input.confirmationDigest !== digest) {
    return {
      outcome: "reject",
      code: "digest_mismatch",
      writes: 0,
      applyPermitted: false,
      reconfirmRequired: true,
      digest,
      plan: null,
    };
  }
  const sourceKey =
    input.secret === null
      ? null
      : localIntakeStoredSourceKey(input.secret, inspected.pkg.analysisId, card.localId, digest);
  if (sourceKey === null) return { ...emptyPreview("schema_rejected"), digest };
  const packageDigest = localIntakePackageDigest(inspected.pkg);
  const plan: LocalIntakeRegistrationPlan = {
    card: {
      title: card.title,
      description: null,
      status: "backlog",
      kind: "unknown",
      priority: card.priority,
      owner: null,
      claimedAt: null,
      pinned: false,
      drag: 0,
      revision: 0,
      sourceSystem: LOCAL_INTAKE_SOURCE_SYSTEM,
      sourceKey,
      sourceVersion: "policy-3",
      sourceDigest: digest,
      sourceSnapshot: {
        agentId: LOCAL_INTAKE_AGENT_ID,
        policyVersion: LOCAL_INTAKE_POLICY_VERSION,
        schemaVersion: LOCAL_INTAKE_SCHEMA_VERSION,
        draftDigest: digest,
        packageDigest,
        snapshotDigest: inspected.pkg.boardSnapshotDigest,
        priority: card.priority,
        localId: card.localId,
      },
      executionBrief: null,
      executionBriefDigest: null,
      normalized: card,
      createsDependencyRows: false,
    },
    approvalStatus: "consumed",
    auditAction: "amux.local_intake.consumed",
    audit: {
      policyVersion: LOCAL_INTAKE_POLICY_VERSION,
      schemaVersion: LOCAL_INTAKE_SCHEMA_VERSION,
      scannerVersion: LOCAL_INTAKE_SCANNER_VERSION,
      draftDigest: digest,
      packageDigest,
      snapshotDigest: inspected.pkg.boardSnapshotDigest,
      cardCount: 1,
      sourceSystem: LOCAL_INTAKE_SOURCE_SYSTEM,
    },
    untouched: LOCAL_INTAKE_UNTOUCHED_TABLES,
  };
  const applyPermitted = localIntakeApplyPermitted(input.envValue, latch);
  return {
    outcome: "allow",
    code: null,
    writes: 0,
    applyPermitted,
    reconfirmRequired: false,
    digest,
    plan,
  };
};

export type LocalIntakeReadBackFact = {
  cardDigest: string | null;
  matchingNormalized: number;
  matchingApprovals: number;
  matchingAudits: number;
  otherRows: number;
};

export const previewLocalIntakePackage = (
  raw: string,
  input: {
    now: Date;
    liveSnapshotDigest: string;
    secret: string | null;
    existingIds: readonly string[];
    envValue: string | undefined;
    codeLatch?: boolean;
  },
): {
  writes: 0;
  code: string | null;
  cards: Array<LocalIntakeCardPreview & { localId: string; title: string; priority: string }>;
} => {
  const inspected = inspectLocalIntakePackage(raw, input);
  if (!inspected.ok) return { writes: 0, code: inspected.code, cards: [] };
  return {
    writes: 0,
    code: inspected.code,
    cards: inspected.pkg.cards.map((card) => ({
      ...previewLocalIntakeCard(raw, { ...input, localId: card.localId }),
      localId: card.localId,
      title: card.title,
      priority: card.priority,
    })),
  };
};

export const classifyLocalIntakeReadBack = (
  fact: LocalIntakeReadBackFact,
  expectedDigest: string,
): "committed" | "absent" | "partial" => {
  const absent =
    fact.cardDigest === null &&
    fact.matchingNormalized === 0 &&
    fact.matchingApprovals === 0 &&
    fact.matchingAudits === 0 &&
    fact.otherRows === 0;
  if (absent) return "absent";
  const committed =
    fact.cardDigest === expectedDigest &&
    fact.matchingNormalized === 1 &&
    fact.matchingApprovals === 1 &&
    fact.matchingAudits === 1 &&
    fact.otherRows === 0;
  return committed ? "committed" : "partial";
};
