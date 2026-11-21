import "server-only";

import type { Prisma } from "@prisma/client";
import { writeSystemAuditLog } from "@/lib/adminAudit";
import {
  MODEL_CATALOG_AUTO_DRAFT_AUDIT_ACTOR,
  MODEL_CATALOG_AUTO_DRAFT_STORED_ACTION,
} from "@/lib/adminAuditSystemActors";

/**
 * The audit entry of a coding catalogue draft the daily scan stored on its own
 * (storeCatalogDraft in lib/modelCatalogAdmin.ts, system path), written in the
 * transaction that stores it. Kept apart from lib/modelCatalogAdmin.ts, which
 * calls the administrator writer for a person's draft: one file, one writer.
 */
export const writeModelCatalogAutoDraftSystemAudit = (
  tx: Prisma.TransactionClient,
  entry: {
    targetId: string;
    summary: string;
    metadata: Prisma.InputJsonObject;
  }
) =>
  writeSystemAuditLog({
    tx,
    systemActor: MODEL_CATALOG_AUTO_DRAFT_AUDIT_ACTOR,
    action: MODEL_CATALOG_AUTO_DRAFT_STORED_ACTION,
    targetType: "ModelCatalogEntry",
    ...entry,
  });
