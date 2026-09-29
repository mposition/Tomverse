/**
 * The engineering agent's system audit entries: one of its listed actors, in
 * the caller's transaction, with metadata of ids, enums and digests only
 * (docs/policy/engineering-agent.md §11).
 *
 * Kept apart from lib/engineeringAgentStore.ts, which also records a person's
 * decisions with the administrator writer: a file that calls that writer must
 * not name the system marker (tests/adminAuditSystemActors.test.ts), so the
 * two kinds of entry are written from two files.
 */

import "server-only";

import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import type { EngineeringAgentSystemAuditActor } from "@/lib/adminAuditSystemActors";

export type EngineeringAgentAuditMetadata = Record<string, string | number | boolean | null>;

export const writeEngineeringAgentSystemAudit = (
  tx: Prisma.TransactionClient,
  actor: EngineeringAgentSystemAuditActor,
  action: string,
  targetType: string,
  targetId: string,
  metadata: EngineeringAgentAuditMetadata,
) =>
  writeSystemAuditLog({
    tx,
    systemActor: actor,
    action,
    targetType,
    targetId,
    summary: `${action} ${targetId}`,
    metadata,
  });
