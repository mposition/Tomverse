import "server-only";

import type { Prisma } from "@prisma/client";
import { writeSystemAuditLog } from "@/lib/adminAudit";
import {
  MODEL_CATALOG_ENV_SYNC_AUDIT_ACTOR,
  MODEL_CATALOG_ENV_SYNCED_ACTION,
  MODEL_CATALOG_ENV_SYNC_TARGET,
} from "@/lib/adminAuditSystemActors";

/**
 * The weekly production-to-staging/dev catalogue copy's audit entry
 * (runModelCatalogEnvSync in lib/modelCatalogEnvSync.ts), written in the
 * transaction that applies the copy. Counts only; the target id is the
 * export's digest.
 */
export const writeModelCatalogEnvSyncSystemAudit = (
  tx: Prisma.TransactionClient,
  entry: {
    targetId: string;
    summary: string;
    metadata: Prisma.InputJsonObject;
  }
) =>
  writeSystemAuditLog({
    tx,
    systemActor: MODEL_CATALOG_ENV_SYNC_AUDIT_ACTOR,
    action: MODEL_CATALOG_ENV_SYNCED_ACTION,
    targetType: MODEL_CATALOG_ENV_SYNC_TARGET,
    ...entry,
  });
