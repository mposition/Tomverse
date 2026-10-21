import "server-only";

import type { Prisma } from "@prisma/client";
import { writeSystemAuditLog } from "@/lib/adminAudit";
import {
  MODEL_CATALOG_RENEWAL_AUDIT_ACTOR,
  MODEL_CATALOG_SNAPSHOT_RENEWED_ACTION,
} from "@/lib/adminAuditSystemActors";

/**
 * The scheduled snapshot renewal's audit entry (renewCodingSnapshotIfUnchanged
 * in lib/modelCatalog.ts), written in the transaction that stores the new
 * version. Kept apart from lib/modelCatalog.ts, which calls the administrator
 * writer for a person's publish: one file, one writer.
 */
export const writeModelCatalogRenewalSystemAudit = (
  tx: Prisma.TransactionClient,
  entry: {
    targetId: string;
    summary: string;
    metadata: Prisma.InputJsonObject;
  }
) =>
  writeSystemAuditLog({
    tx,
    systemActor: MODEL_CATALOG_RENEWAL_AUDIT_ACTOR,
    action: MODEL_CATALOG_SNAPSHOT_RENEWED_ACTION,
    targetType: "ModelCatalogSnapshot",
    ...entry,
  });
