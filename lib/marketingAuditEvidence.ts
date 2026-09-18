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
 * - its own hash reproduces. A forged row would have to be written with a
 *   listed signing key, which is the same bar the chain verifier applies.
 *
 * What it does not check: that the row is correctly linked to its neighbours.
 * That is a property of the chain rather than of one entry, and
 * `verifyAdminAuditIntegrity()` is what answers it; a per-row linkage read here
 * would be a second, weaker implementation of the same walk.
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
  | "entry_unhashed"
  | "entry_hash_mismatch";

export type MarketingAuditRequirement = {
  auditLogId: string;
  action: string;
  targetId: string;
  /** Metadata keys that must be present with exactly these values. */
  metadata?: Readonly<Record<string, string>>;
};

export type MarketingAuditVerdict =
  | { ok: true; createdAt: Date }
  | { ok: false; problem: MarketingAuditProblem };

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

  return { ok: true, createdAt: entry.createdAt };
}
