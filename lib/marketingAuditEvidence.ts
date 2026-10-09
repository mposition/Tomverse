/**
 * Reading one audit entry as evidence that a person authorised something.
 *
 * Contract: docs/policy/marketing-automation.md §6 and §8.2. Two marketing
 * movements are an operator's decision rather than the system's -- returning a
 * paused account to autonomous mode, and re-queueing a post whose publication
 * failed -- and the database can only check that the column naming the entry
 * changed. What the entry *says* is checked here, before the write.
 *
 * What is checked, and why each part is needed:
 *
 * - the entry exists and is the exact action, so a row recording something else
 *   entirely cannot stand in for the one that was required;
 * - it has a human actor: an entry whose metadata claims a system actor is one
 *   of the agents' own, and an agent authorising its own resume is the thing
 *   §8.2 exists to prevent;
 * - it records that the actor held `marketing:write` at the time, which the S2
 *   route writes after its own permission check -- permissions can change, and
 *   what matters is what was true when the decision was made;
 * - it targets this row and no other;
 * - it was written after the thing it authorises. An entry that already existed
 *   is a record of an earlier decision, and without this the same two entries
 *   could be used alternately to resume an account for ever;
 * - its own hash reproduces, and it is linked to the entries either side of it.
 *   A forged row would have to be written with a listed signing key; a row
 *   lifted out of the chain and re-inserted would keep its hash but lose its
 *   links, which is what the linkage read catches.
 *
 * What it does not check: the rest of the chain. `verifyAdminAuditIntegrity()`
 * walks every row and is what answers "is the log intact"; this answers "is
 * this row still where it was written", which is the part a single decision
 * depends on.
 */

import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  adminAuditEntryHashVariants,
  adminAuditIntegrityKeys,
  ADMIN_AUDIT_VERIFICATION_KEY_ORDERS,
} from "@/lib/adminAuditIntegrityCore";
import {
  auditRowActorKind,
  metadataClaimsSystemActor,
  SYSTEM_AUDIT_ACTOR_METADATA_KEY,
  type SystemAuditActor,
} from "@/lib/adminAuditSystemActors";

export type MarketingAuditReader = PrismaClient | Prisma.TransactionClient;

/**
 * Why an audit entry is not evidence of what a caller said it was.
 *
 * A value rather than a type union, because callers build refusal codes from
 * it -- `resume_evidence_${problem}` and two others -- and a list that only
 * exists at compile time left thirty such codes with no HTTP meaning and no
 * test able to notice. The type is derived from the array so there is still
 * one list.
 */
export const MARKETING_AUDIT_PROBLEMS = [
  "entry_missing",
  "action_mismatch",
  "actor_not_human",
  "marketing_write_not_recorded",
  "target_mismatch",
  "metadata_mismatch",
  "entry_predates_decision",
  "entry_unhashed",
  "entry_hash_mismatch",
  "entry_not_linked",
] as const;

export type MarketingAuditProblem = (typeof MARKETING_AUDIT_PROBLEMS)[number];

export type MarketingAuditRequirement = {
  auditLogId: string;
  action: string;
  targetId: string;
  /** Metadata keys that must be present with exactly these values. */
  metadata?: Readonly<Record<string, string | number | boolean>>;
  /**
   * The moment the entry has to be later than: the pause it resumes, the
   * failure it re-queues. Without it an entry written for an earlier decision
   * is evidence for this one too.
   */
  notBefore?: Date;
};

export type MarketingAuditVerdict =
  | { ok: true; createdAt: Date }
  | { ok: false; problem: MarketingAuditProblem };

export const MARKETING_WEBHOOK_VERIFICATION_SIGNED_ACTION =
  "marketing_webhook.verification_signed";

export type MarketingWebhookSignatureAuditBinding = {
  signatureAuditLogId: string;
  recordId: string;
  recordDigest: string;
};

/**
 * Opaque proof returned only after the hash-chained human audit row is read.
 * The private unique-symbol member prevents callers from manufacturing a
 * structurally identical `verified: true` object in TypeScript.
 */
declare const marketingWebhookSignatureAuditEvidenceBrand: unique symbol;
export type MarketingWebhookSignatureAuditEvidence = {
  auditLogId: string;
  action: typeof MARKETING_WEBHOOK_VERIFICATION_SIGNED_ACTION;
  targetId: string;
  recordDigest: string;
  verified: boolean;
  readonly [marketingWebhookSignatureAuditEvidenceBrand]: true;
};

/**
 * The exact human-audit claim a webhook verification signature must prove.
 * Kept here beside the hash-chain verifier so S2 cannot accidentally verify a
 * generic marketing action and then label the resulting boolean a signature.
 */
export const marketingWebhookSignatureAuditRequirement = (
  binding: MarketingWebhookSignatureAuditBinding,
): MarketingAuditRequirement => ({
  auditLogId: binding.signatureAuditLogId,
  action: MARKETING_WEBHOOK_VERIFICATION_SIGNED_ACTION,
  targetId: binding.recordId,
  metadata: { recordDigest: binding.recordDigest },
});

/**
 * A value the audit row actually recorded.
 *
 * `Object.hasOwn`, not a bare index. Prisma hands back a plain object that
 * inherits from `Object.prototype`, so without it a property set there would
 * satisfy every metadata requirement an audit row did not record -- including
 * `actorHadMarketingWrite`, which is the one saying a person had permission to
 * do the thing this row is evidence of.
 */
const metadataValue = (metadata: unknown, key: string): unknown =>
  metadata &&
  typeof metadata === "object" &&
  !Array.isArray(metadata) &&
  Object.hasOwn(metadata, key)
    ? (metadata as Record<string, unknown>)[key]
    : undefined;

export async function verifyMarketingAuditEvidence(
  database: MarketingAuditReader,
  requirement: MarketingAuditRequirement,
): Promise<MarketingAuditVerdict> {
  const entry = await database.adminAuditLog.findUnique({
    where: { id: requirement.auditLogId },
  });

  if (!entry) return { ok: false, problem: "entry_missing" };
  if (entry.action !== requirement.action) {
    return { ok: false, problem: "action_mismatch" };
  }
  if (!entry.actorUserId || metadataClaimsSystemActor(entry.metadata)) {
    return { ok: false, problem: "actor_not_human" };
  }
  if (metadataValue(entry.metadata, "actorHadMarketingWrite") !== true) {
    return { ok: false, problem: "marketing_write_not_recorded" };
  }
  if (entry.targetId !== requirement.targetId) {
    return { ok: false, problem: "target_mismatch" };
  }
  for (const [key, value] of Object.entries(requirement.metadata ?? {})) {
    if (metadataValue(entry.metadata, key) !== value) {
      return { ok: false, problem: "metadata_mismatch" };
    }
  }
  if (
    requirement.notBefore &&
    entry.createdAt.getTime() <= requirement.notBefore.getTime()
  ) {
    return { ok: false, problem: "entry_predates_decision" };
  }

  const placed = await chainPlacementProblem(database, entry);
  if (placed) return { ok: false, problem: placed };

  return { ok: true, createdAt: entry.createdAt };
}

type StoredAuditEntry = NonNullable<
  Awaited<ReturnType<MarketingAuditReader["adminAuditLog"]["findUnique"]>>
>;

/**
 * Whether a stored entry's own hash reproduces under a listed key and it still
 * sits where it was written. Shared by the human and the system verifier: the
 * part of being evidence that does not depend on who wrote the entry.
 */
async function chainPlacementProblem(
  database: MarketingAuditReader,
  entry: StoredAuditEntry,
): Promise<"entry_unhashed" | "entry_hash_mismatch" | "entry_not_linked" | null> {
  // An entry with no hash is outside what verification covers
  // (lib/adminAudit.ts writes one whenever a key is configured), so it is not
  // evidence either -- a decision that cannot be checked is not a decision that
  // was recorded.
  if (!entry.entryHash) return "entry_unhashed";

  const input = {
    previousHash: entry.previousHash,
    actorUserId: entry.actorUserId,
    actorEmail: entry.actorEmail,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    summary: entry.summary,
    metadata: entry.metadata,
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent,
    createdAt: entry.createdAt.toISOString(),
  };

  const keys = adminAuditIntegrityKeys(process.env);
  const reproduced = keys.some((key) => {
    const variants = adminAuditEntryHashVariants(input, key);
    return ADMIN_AUDIT_VERIFICATION_KEY_ORDERS.some(
      (order) => variants[order] === entry.entryHash,
    );
  });

  if (!reproduced) return "entry_hash_mismatch";

  // Where the entry sits. The chain is ordered by (createdAt, id), so the row
  // before it must be the one its `previousHash` names, and the row after it --
  // if there is one -- must name this entry's hash. A row detached from the
  // chain still reproduces its own hash; what it loses is its place.
  const [before, after] = await Promise.all([
    database.adminAuditLog.findFirst({
      where: {
        entryHash: { not: null },
        OR: [
          { createdAt: { lt: entry.createdAt } },
          { createdAt: entry.createdAt, id: { lt: entry.id } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { entryHash: true },
    }),
    database.adminAuditLog.findFirst({
      where: {
        entryHash: { not: null },
        OR: [
          { createdAt: { gt: entry.createdAt } },
          { createdAt: entry.createdAt, id: { gt: entry.id } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { previousHash: true },
    }),
  ]);

  if (entry.previousHash !== (before?.entryHash ?? null)) return "entry_not_linked";
  if (after && after.previousHash !== entry.entryHash) return "entry_not_linked";
  return null;
}

/** The target type the store writes for a post's audit entries. */
export const MARKETING_POST_AUDIT_TARGET_TYPE = "MarketingPost";

/** The target type a shadow report's audit entry names. */
export const MARKETING_REPORT_AUDIT_TARGET_TYPE = "MarketingReport";

/** Why a system audit entry is not evidence of what the system recorded. */
export const MARKETING_SYSTEM_AUDIT_PROBLEMS = [
  "entry_missing",
  "actor_not_system",
  "actor_mismatch",
  "target_mismatch",
  "entry_unhashed",
  "entry_hash_mismatch",
  "entry_not_linked",
] as const;

export type MarketingSystemAuditProblem = (typeof MARKETING_SYSTEM_AUDIT_PROBLEMS)[number];

/**
 * The latest entry a system actor wrote for this action and target, read as
 * evidence -- or why it is not.
 *
 * What the dispatch of an autonomous post compares against is what the
 * autonomous insert recorded: the admission code digest, configuration
 * generation and deployment it was admitted under. Values alone are not enough:
 * a row with the right metadata and no hash, a row written by another actor, or
 * a row lifted out of the chain would all carry the same values. So the row has
 * to be a system row (no session fields, a listed marker), by the named actor,
 * about the named target, with a hash that reproduces under a listed key and
 * links to the rows either side of it.
 *
 * The latest one, because a requeued post may have been scheduled more than
 * once, and the admission it goes out under is the most recent.
 */
export async function verifyMarketingSystemAuditEvidence(
  database: MarketingAuditReader,
  requirement: {
    readonly action: string;
    readonly systemActor: SystemAuditActor;
    readonly targetType: string;
    readonly targetId: string;
  },
): Promise<
  | { readonly ok: true; readonly auditLogId: string; readonly metadata: unknown }
  | { readonly ok: false; readonly problem: MarketingSystemAuditProblem }
> {
  const entry = await database.adminAuditLog.findFirst({
    where: { action: requirement.action, targetId: requirement.targetId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!entry) return { ok: false, problem: "entry_missing" };
  if (auditRowActorKind(entry) !== "system") {
    return { ok: false, problem: "actor_not_system" };
  }
  if (metadataValue(entry.metadata, SYSTEM_AUDIT_ACTOR_METADATA_KEY) !== requirement.systemActor) {
    return { ok: false, problem: "actor_mismatch" };
  }
  if (entry.targetType !== requirement.targetType || entry.targetId !== requirement.targetId) {
    return { ok: false, problem: "target_mismatch" };
  }
  const placed = await chainPlacementProblem(database, entry);
  if (placed) return { ok: false, problem: placed };
  return { ok: true, auditLogId: entry.id, metadata: entry.metadata };
}

export async function verifyMarketingWebhookSignatureAuditEvidence(
  database: MarketingAuditReader,
  binding: MarketingWebhookSignatureAuditBinding,
): Promise<MarketingWebhookSignatureAuditEvidence> {
  const verdict = await verifyMarketingAuditEvidence(
    database,
    marketingWebhookSignatureAuditRequirement(binding),
  );
  return {
    auditLogId: binding.signatureAuditLogId,
    action: MARKETING_WEBHOOK_VERIFICATION_SIGNED_ACTION,
    targetId: binding.recordId,
    recordDigest: binding.recordDigest,
    verified: verdict.ok,
  } as MarketingWebhookSignatureAuditEvidence;
}
