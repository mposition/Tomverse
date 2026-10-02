/**
 * The only writer of `ProductResearchObservation`
 * (docs/policy/product-research-agent.md §4, §5).
 *
 * Two writes exist and no others: a slot is recorded, and rows past the
 * retention period are removed. Both carry a system audit entry in the same
 * transaction as the change, through `writeSystemAuditLog()` -- the audit table
 * is never written directly.
 *
 * What this module deliberately does not do:
 *
 *   - decide whether the body is acceptable. That is
 *     `admitObservationSubmission()`, which is pure and tested without a
 *     database.
 *   - check whether the slot is taken, or whether its window is open. The
 *     database owns both. A check-then-insert here would let two runs of the
 *     same slot both find it empty.
 *   - correct a stored row. There is no update path, because there is nothing
 *     to correct: a slot's answer is what the run found.
 */

import "server-only";

import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import { OBSERVATION_RETENTION_DAYS } from "@/lib/productResearchObservationCore.mjs";

/** A refusal this module decided, as an enum the caller may answer with. */
export class ProductResearchObservationRefusedError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ProductResearchObservationRefusedError";
    this.code = code;
  }
}

export type ObservationRow = {
  id: string;
  slot: Date;
  outcome: "ok" | "failed";
  failureStage: string | null;
  schemaVersion: number;
  developSha: string | null;
  mainSha: string | null;
  issueCount: number | null;
  /**
   * The validated observation payload, or null on a failed slot.
   *
   * `unknown` rather than Prisma's JSON type because the module that produced
   * it is plain JavaScript and cannot name one. It has already been through
   * `validateObservationPayload()`, which is what makes it JSON; the cast at
   * the Prisma call is that fact, not an escape from it.
   */
  payload: unknown;
  payloadDigest: string | null;
};

/** Postgres' unique violation, which here means the slot already has a row. */
const isUniqueViolation = (error: unknown) =>
  typeof (error as { code?: unknown })?.code === "string" &&
  (error as { code: string }).code === "P2002";

/** A CHECK or a trigger refused the row: the window, the shape, a value. */
const isConstraintViolation = (error: unknown) =>
  typeof (error as { code?: unknown })?.code === "string" &&
  ["P2004", "P2010"].includes((error as { code: string }).code);

/**
 * Records one slot.
 *
 * The audit entry and the row are one commit. The entry's metadata carries the
 * slot, the outcome and the digest -- never an issue title or the payload: the
 * audit chain is read by people looking for what happened, and putting the
 * observation in it would duplicate the retention boundary into a table that
 * has none.
 */
export async function recordProductResearchObservation(row: ObservationRow): Promise<{
  id: string;
  auditLogId: string;
}> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const created = await tx.productResearchObservation.create({
          data: {
            id: row.id,
            slot: row.slot,
            outcome: row.outcome,
            failureStage: row.failureStage,
            schemaVersion: row.schemaVersion,
            developSha: row.developSha,
            mainSha: row.mainSha,
            issueCount: row.issueCount,
            payload: (row.payload ?? undefined) as Prisma.InputJsonValue | undefined,
            payloadDigest: row.payloadDigest,
          },
          select: { id: true },
        });
        const auditLogId = await writeSystemAuditLog({
          tx,
          systemActor: "product-research-observer",
          action: "product_research.observation.recorded",
          targetType: "ProductResearchObservation",
          targetId: created.id,
          summary: `Observation slot ${row.slot.toISOString()} recorded as ${row.outcome}`,
          metadata: {
            slot: row.slot.toISOString(),
            outcome: row.outcome,
            failureStage: row.failureStage,
            issueCount: row.issueCount,
            payloadDigest: row.payloadDigest,
            developSha: row.developSha,
            mainSha: row.mainSha,
          },
        });
        return { id: created.id, auditLogId };
      },
      { timeout: 20_000 },
    );
  } catch (error) {
    // The slot is the idempotency key. A second submission for a slot that
    // already has a row is not an error the caller should retry past: the
    // answer for that slot exists.
    if (isUniqueViolation(error)) {
      throw new ProductResearchObservationRefusedError("slot_already_recorded");
    }
    if (isConstraintViolation(error)) {
      throw new ProductResearchObservationRefusedError("refused_by_database");
    }
    throw error;
  }
}

/**
 * Removes rows past the retention period.
 *
 * The cutoff is computed from the same constant the migration's trigger pins,
 * so a row the sweep selects is one the trigger will let go of; a sweep with a
 * shorter horizon would send every delete into that refusal. There is no
 * exception for the newest row -- a row still inside the period is kept
 * whether or not anything newer exists.
 *
 * Returns the number removed. Zero is the ordinary answer for the first 90
 * days and is not a failure.
 */
export async function sweepProductResearchObservations(
  now: Date = new Date(),
): Promise<{ removed: number }> {
  const cutoff = new Date(now.getTime() - OBSERVATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return prisma.$transaction(
    async (tx) => {
      // Read first, so the audit entry can say which slots went without the
      // delete's own count standing in for them.
      const due = await tx.productResearchObservation.findMany({
        where: { submittedAt: { lt: cutoff } },
        select: { id: true, slot: true },
        orderBy: { slot: "asc" },
        take: 500,
      });
      if (due.length === 0) return { removed: 0 };

      const { count } = await tx.productResearchObservation.deleteMany({
        where: { id: { in: due.map((entry) => entry.id) } },
      });
      await writeSystemAuditLog({
        tx,
        systemActor: "product-research-retention",
        action: "product_research.observation.swept",
        targetType: "ProductResearchObservation",
        targetId: null,
        summary: `Removed ${count} observation slots older than ${OBSERVATION_RETENTION_DAYS} days`,
        metadata: {
          removed: count,
          cutoff: cutoff.toISOString(),
          oldestSlot: due[0].slot.toISOString(),
          newestSlot: due[due.length - 1].slot.toISOString(),
        },
      });
      return { removed: count };
    },
    { timeout: 20_000 },
  );
}
