import "server-only";

import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_AUTO_PROMOTER_AUDIT_ACTOR } from "@/lib/adminAuditSystemActors";

/**
 * The auto-promotion tick's only audit writer.
 *
 * docs/policy/development-agent-orchestration.md (version 15, "자동 승격
 * 개정") names the system actor `amux-auto-promoter`. It writes in the caller's
 * transaction, on the same chain as the owner's entries. This module never
 * calls the administrator writer, so a human entry cannot come out of it and a
 * system entry cannot come out of the administrator path.
 */
export const writeAutoPromoterAudit = (
  tx: Prisma.TransactionClient,
  entry: {
    action: string;
    targetType: string;
    targetId: string;
    summary: string;
    metadata: Record<string, string | number | null>;
  },
): Promise<string> =>
  writeSystemAuditLog({
    tx,
    systemActor: AMUX_AUTO_PROMOTER_AUDIT_ACTOR,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    summary: entry.summary,
    metadata: entry.metadata,
  });
