import "server-only";

import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/adminAuditSystemActors";

/**
 * The system audit writer of orchestration policy version 20: the halt the
 * orchestrator records (`amux.orchestrator.halted`) and the resolver's
 * rollback confirmation (`amux.orchestrator.write_resolved`). The actor is the
 * existing `tomverse-amux-orchestrator`; this version adds no system actor.
 *
 * Kept apart from lib/amux/orchestratorHaltStore.ts, which also writes the
 * human `amux.orchestrator.halt_cleared` through the administrator writer, so
 * no file calls both writers and a human entry cannot come out of the system
 * path (tests/adminAuditSystemActors.test.ts). Writes in the caller's
 * transaction, on the same chain as every other entry.
 */
export const writeAmuxOrchestratorSystemAudit = (
  tx: Prisma.TransactionClient,
  entry: {
    action: string;
    targetType: string;
    targetId: string;
    summary: string;
    metadata: Record<string, string>;
  },
): Promise<string> =>
  writeSystemAuditLog({
    tx,
    systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    summary: entry.summary,
    metadata: entry.metadata,
  });
