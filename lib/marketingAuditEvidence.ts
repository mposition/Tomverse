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
import { metadataClaimsSystemActor } from "@/lib/adminAuditSystemActors";

export type MarketingAuditReader = PrismaClient | Prisma.TransactionClient;

/** Why an audit entry is not evidence of what a caller said it was. */
export type MarketingAuditProblem =
  | "entry_missing"
  | "action_mismatch"
  | "actor_not_human"
  | "marketing_write_not_recorded"
  | "target_mismatch"
  | "metadata_mismatch"
  | "entry_predates_decision"
  | "entry_unhashed"
  | "entry_hash_mismatch"
  | "entry_not_linked";

export type MarketingAuditRequirement = {
  auditLogId: string;
  action: string;
  targetId: string;
  /** Metadata keys that must be present with exactly these values. */
  metadata?: Readonly<Record<string, string>>;
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

const metadataValue = (metadata: unknown, key: string): unknown =>
  metadata && typeof metadata === "object" && !Array.isArray(metadata)
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

  // An entry with no hash is outside what verification covers
  // (lib/adminAudit.ts writes one whenever a key is configured), so it is not
  // evidence either -- a decision that cannot be checked is not a decision that
  // was recorded.
  if (!entry.entryHash) return { ok: false, problem: "entry_unhashed" };

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

  if (!reproduced) return { ok: false, problem: "entry_hash_mismatch" };

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

  if (entry.previousHash !== (before?.entryHash ?? null)) {
    return { ok: false, problem: "entry_not_linked" };
  }
  if (after && after.previousHash !== entry.entryHash) {
    return { ok: false, problem: "entry_not_linked" };
  }

  return { ok: true, createdAt: entry.createdAt };
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
