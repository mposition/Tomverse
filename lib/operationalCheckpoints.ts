import "server-only";

import { prisma } from "@/lib/prisma";

export const OPERATIONAL_CHECKPOINT_DEFINITIONS = [
  { key: "database_backup", name: "Database backup", defaultDueDays: 1 },
  { key: "database_restore_drill", name: "Database restore drill", defaultDueDays: 90 },
  { key: "admin_access_review", name: "Administrator access review", defaultDueDays: 90 },
  { key: "audit_external_archive", name: "Audit log external archive", defaultDueDays: 7 },
] as const;

export type OperationalCheckpointKey =
  (typeof OPERATIONAL_CHECKPOINT_DEFINITIONS)[number]["key"];

export async function getOperationalCheckpoints(now = new Date()) {
  const existing = await prisma.adminOperationalCheckpoint.findMany({
    where: {
      key: { in: OPERATIONAL_CHECKPOINT_DEFINITIONS.map((item) => item.key) },
    },
  });
  const byKey = new Map(existing.map((row) => [row.key, row]));
  return OPERATIONAL_CHECKPOINT_DEFINITIONS.map((definition) => {
    const row = byKey.get(definition.key);
    const overdue = !row?.nextDueAt || row.nextDueAt <= now;
    return {
      key: definition.key,
      name: definition.name,
      status: row?.status || "not_verified",
      observedAt: row?.observedAt?.toISOString() || null,
      nextDueAt: row?.nextDueAt?.toISOString() || null,
      detail: row?.detail || null,
      evidenceUrl: row?.evidenceUrl || null,
      updatedByEmail: row?.updatedByEmail || null,
      updatedAt: row?.updatedAt.toISOString() || null,
      overdue,
      defaultDueDays: definition.defaultDueDays,
    };
  });
}
