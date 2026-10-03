import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import {
  QA_RELEASE_SECRET_ROTATION_FIELDS,
  type QaReleaseSecretRotationField,
} from "@/lib/qaReleaseOperatorControlFields";

/**
 * The only writer of QaReleaseOperatorControl (docs/policy/qa-release-agent.md
 * section 6; scripts/check-protected-table-writers-core.mjs names this file).
 *
 * A revision is an Admin action: the audit row is written first, in the same
 * transaction, with the new revision as its target, and the row then names
 * that audit row. The database checks both halves -- consecutive revisions
 * and a same-transaction audit row by a person -- so a writer that skipped
 * either would be refused, not merely reviewed.
 *
 * Secrets are recorded by their rotation time, never by value.
 */

export const QA_RELEASE_CONTROL_AUDIT_ACTION = "qa_release.control_recorded";

/**
 * The write's limits, derived the way policy section 10 derives the digest
 * store's: eight statements (the limits, the chain lock, the newest
 * revision, the four of the audit append, the insert), so 3A + 5 = 29 s, and
 * Prisma five seconds more.
 */
export const QA_RELEASE_CONTROL_WRITE_LIMITS = Object.freeze({
  statementMs: 2_000,
  idleMs: 1_000,
  statements: 8,
  transactionMs: (3 * 8 + 5) * 1_000,
  prismaMs: (3 * 8 + 5) * 1_000 + 5_000,
});
const LIMITS = QA_RELEASE_CONTROL_WRITE_LIMITS;

export { QA_RELEASE_SECRET_ROTATION_FIELDS };
type RotationField = QaReleaseSecretRotationField;

export type QaReleaseOperatorControlInput = {
  digestEnabled: boolean;
  mergeLaneEnabled: boolean;
  developLaneOn: boolean;
  iacCommit: string | null;
} & Record<RotationField, Date | null>;

export type QaReleaseOperatorControlRecord = QaReleaseOperatorControlInput & {
  revision: number;
  auditLogId: string;
  createdAt: Date;
};

export class QaReleaseOperatorControlRefusedError extends Error {
  constructor(readonly code: "iac_commit_invalid" | "revision_taken") {
    super(code);
    this.name = "QaReleaseOperatorControlRefusedError";
  }
}

/** The newest revision, or null when none has been recorded. */
export async function readLatestQaReleaseOperatorControl(
  db: Pick<Prisma.TransactionClient, "qaReleaseOperatorControl"> = prisma,
): Promise<QaReleaseOperatorControlRecord | null> {
  return db.qaReleaseOperatorControl.findFirst({ orderBy: { revision: "desc" } });
}

/** Appends the next revision and its audit row in one transaction. */
export async function recordQaReleaseOperatorControl(
  input: { session: Session; request?: Request; control: QaReleaseOperatorControlInput },
  db: Pick<typeof prisma, "$transaction"> = prisma,
): Promise<QaReleaseOperatorControlRecord> {
  const { control } = input;
  if (control.iacCommit !== null && !/^[0-9a-f]{40}$/.test(control.iacCommit)) {
    throw new QaReleaseOperatorControlRefusedError("iac_commit_invalid");
  }
  try {
    return await db.$transaction(
      async (tx) => {
        // The limits first: they arm for the statements after this one.
        await tx.$executeRaw`SELECT
          set_config('statement_timeout', ${String(LIMITS.statementMs)}, true),
          set_config('idle_in_transaction_session_timeout', ${String(LIMITS.idleMs)}, true),
          CASE WHEN current_setting('server_version_num')::int >= 170000
            THEN set_config('transaction_timeout', ${String(LIMITS.transactionMs)}, true)
          END`;
        // The audit chain's lock before the read, under the statement limit:
        // it serializes every audit write, so a second operator saving at once
        // reads the first one's revision instead of computing the same number.
        await takeAuditChainLock(tx);
        const newest = await tx.qaReleaseOperatorControl.findFirst({
          orderBy: { revision: "desc" },
          select: { revision: true },
        });
        const revision = (newest?.revision ?? 0) + 1;
        const auditLogId = await writeAdminAuditLog({
          tx,
          session: input.session,
          request: input.request,
          action: QA_RELEASE_CONTROL_AUDIT_ACTION,
          targetType: "QaReleaseOperatorControl",
          targetId: String(revision),
          summary: `Recorded QA-release operator control revision ${revision}.`,
          // Which secrets were rotated and when; never a value.
          metadata: {
            revision,
            digestEnabled: control.digestEnabled,
            mergeLaneEnabled: control.mergeLaneEnabled,
            developLaneOn: control.developLaneOn,
            iacCommit: control.iacCommit,
            rotated: Object.fromEntries(
              QA_RELEASE_SECRET_ROTATION_FIELDS.map((field) => [field, control[field]?.toISOString() ?? null]),
            ),
          },
        });
        return tx.qaReleaseOperatorControl.create({
          data: { ...control, revision, auditLogId },
        });
      },
      { maxWait: 5_000, timeout: LIMITS.prismaMs },
    );
  } catch (error) {
    // The lock above serializes saves; should two ever compute one number,
    // the primary key admits one and the other answers "taken", not a 500.
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      throw new QaReleaseOperatorControlRefusedError("revision_taken");
    }
    throw error;
  }
}
