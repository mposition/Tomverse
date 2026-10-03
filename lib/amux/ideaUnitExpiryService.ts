import "server-only";

import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/adminAuditSystemActors";

const EXPIRE_ACTION = "amux.v4.unit.expire";
const TARGET = "AmuxIdeaUnitDecision";

export class AmuxUnitExpiryError extends Error {
  constructor(readonly code: "already_prepared" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxUnitExpiryError";
  }
}

export function mayExpireAmuxPreparedUnit(row: {
  state: string; expiresAt: Date; outcomeUnknownAt: Date | null;
}, now: Date): boolean {
  return row.state === "prepared" && row.outcomeUnknownAt === null &&
    row.expiresAt instanceof Date && Number.isFinite(row.expiresAt.getTime()) &&
    now instanceof Date && Number.isFinite(now.getTime()) &&
    now >= row.expiresAt;
}

/** Called only after the canonical audit lock and locked idea/source rows.
 * A consumed decision is permanent. An unknown outcome cannot expire until
 * the owner proves no commit; neither case is silently replaced. */
export async function expireStaleAmuxUnitDecision(tx: Prisma.TransactionClient,
  draftUnitId: string): Promise<void> {
  const existing = await tx.amuxIdeaUnitDecision.findMany({
    where: { draftUnitId, state: { in: ["prepared", "consumed"] } },
    take: 2,
  });
  if (existing.some((row) => row.state === "consumed") || existing.length > 1) {
    throw new AmuxUnitExpiryError("already_prepared");
  }
  const stale = existing[0];
  if (!stale) return;
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaUnitDecision"
    WHERE "id" = ${stale.id} AND "state" = 'prepared' FOR UPDATE
  `;
  const refreshed = await tx.amuxIdeaUnitDecision.findUnique({
    where: { id: stale.id },
  });
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (locked.length !== 1 || !refreshed ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AmuxUnitExpiryError("integrity_unavailable");
  }
  if (!mayExpireAmuxPreparedUnit(refreshed, now)) {
    throw new AmuxUnitExpiryError("already_prepared");
  }
  const auditId = await writeSystemAuditLog({ tx,
    systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
    action: EXPIRE_ACTION, targetType: TARGET, targetId: refreshed.id,
    summary: "Expired an unconsumed AMUX v4 unit confirmation before a new owner decision.",
    metadata: { ideaId: refreshed.ideaId,
      draftUnitId: refreshed.draftUnitId,
      prepareRequestId: refreshed.prepareRequestId,
      expiredAt: now.toISOString(), action: refreshed.action,
      registered: false },
  });
  const expired = await tx.amuxIdeaUnitDecision.updateMany({
    where: { id: refreshed.id, draftUnitId, state: "prepared",
      expiresAt: { lte: now }, outcomeUnknownAt: null },
    data: { state: "expired", finalAuditLogId: auditId },
  });
  if (expired.count !== 1) throw new AmuxUnitExpiryError("integrity_unavailable");
}
