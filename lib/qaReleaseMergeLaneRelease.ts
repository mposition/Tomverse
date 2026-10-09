import "server-only";

import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";

/**
 * A person's release of the QA-release merge lane latch
 * (docs/policy/qa-release-agent.md version 4, section 8 item 5; section 10's
 * fourth transaction). The other writer of QaReleaseMergeAttempt and
 * QaReleaseMergeLaneLatch is the merge lane service's,
 * lib/qaReleaseMergeLaneStore.ts; this one writes only an administrator's
 * audit row, so no module writes both kinds
 * (tests/adminAuditSystemActors.test.ts).
 */

export const QA_RELEASE_MERGE_LANE_RELEASED_ACTION = "qa_release.merge_lane_released";
export const QA_RELEASE_MERGE_ATTEMPT_RESOLVED_ACTION = "qa_release.merge_attempt_resolved";

/**
 * A person's latch release (policy section 10): nine statements -- the
 * limits, the audit chain lock, one read of the newest latch event and the
 * open attempt, the four of the person's audit append, the conditional
 * attempt change when the person chose one, and the release event -- so
 * 3A + 5 = 32 s, and the limits are always armed for nine. A person's Admin
 * write has no round, so there is no deadline check (section 3).
 */
export const QA_RELEASE_LATCH_RELEASE_LIMITS = Object.freeze({
  statementMs: 2_000,
  idleMs: 1_000,
  statements: 9,
  transactionMs: (3 * 9 + 5) * 1_000,
  prismaMs: (3 * 9 + 5) * 1_000 + 5_000,
});
const RELEASE = QA_RELEASE_LATCH_RELEASE_LIMITS;

/**
 * What the person confirmed about the attempt the rules could not end
 * (policy section 8 item 5): two facts for each state, nothing else.
 */
export type QaReleaseAttemptResolution =
  | { attemptId: string; shownState: "issued" | "consumed"; fact: "not_merged" }
  | { attemptId: string; shownState: "issued" | "consumed"; fact: "merged_on_develop"; mergeCommitSha: string }
  | { attemptId: string; shownState: "awaiting_deploy"; fact: "deployed" | "restored" };

export type QaReleaseLatchReleaseRefusal = "not_latched" | "attempt_changed" | "invalid_resolution";

export type QaReleaseLatchReleaseResult =
  | { released: true; sequence: number }
  | { released: false; reason: QaReleaseLatchReleaseRefusal };

class LatchReleaseRefused extends Error {
  constructor(readonly reason: QaReleaseLatchReleaseRefusal) {
    super(reason);
  }
}

const resolutionMove = (resolution: QaReleaseAttemptResolution) => {
  if (resolution.shownState === "awaiting_deploy") {
    return { to: "closed", outcome: resolution.fact === "deployed" ? "person_deployed" : "person_restored", mergeCommitSha: null };
  }
  if (resolution.fact === "not_merged") return { to: "closed", outcome: "person_not_merged", mergeCommitSha: null };
  return { to: "awaiting_deploy", outcome: null, mergeCommitSha: resolution.mergeCommitSha };
};

/**
 * Releases the merge lane's latch, and with it, when the person chose, ends
 * the attempt the rules could not (policy section 8 item 5). The attempt
 * change is bound to the attempt id and state the screen showed: if a round
 * moved it meanwhile, nothing is written -- not the audit, not the release --
 * and the screen reads again.
 *
 * The person's audit row is written before the attempt change, not after as
 * section 10 lists it: the attempt's trigger requires that row to exist in
 * the transaction. The statement count and the all-or-nothing rule are the
 * same.
 */
export async function releaseQaReleaseMergeLaneLatch(input: {
  session: Session;
  request?: Request;
  resolution: QaReleaseAttemptResolution | null;
}): Promise<QaReleaseLatchReleaseResult> {
  const { resolution } = input;
  if (resolution && resolution.shownState !== "awaiting_deploy" && resolution.fact === "merged_on_develop") {
    if (!/^[0-9a-f]{40}$/.test(resolution.mergeCommitSha)) return { released: false, reason: "invalid_resolution" };
  }
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT
          set_config('statement_timeout', ${String(RELEASE.statementMs)}, true),
          set_config('idle_in_transaction_session_timeout', ${String(RELEASE.idleMs)}, true),
          CASE WHEN current_setting('server_version_num')::int >= 170000
            THEN set_config('transaction_timeout', ${String(RELEASE.transactionMs)}, true)
          END`;
        await takeAuditChainLock(tx);
        const [read] = await tx.$queryRaw<{ sequence: number | null; latched: boolean | null }[]>`SELECT
            (SELECT "sequence" FROM "QaReleaseMergeLaneLatch" ORDER BY "sequence" DESC LIMIT 1) AS "sequence",
            (SELECT "latched" FROM "QaReleaseMergeLaneLatch" ORDER BY "sequence" DESC LIMIT 1) AS "latched"`;
        if (read.latched !== true) throw new LatchReleaseRefused("not_latched");
        const sequence = (read.sequence ?? 0) + 1;

        const auditLogId = await writeAdminAuditLog({
          tx,
          session: input.session,
          request: input.request,
          action: resolution ? QA_RELEASE_MERGE_ATTEMPT_RESOLVED_ACTION : QA_RELEASE_MERGE_LANE_RELEASED_ACTION,
          targetType: resolution ? "QaReleaseMergeAttempt" : "QaReleaseMergeLaneLatch",
          targetId: resolution ? resolution.attemptId : String(sequence),
          summary: resolution
            ? `Released the merge lane latch and recorded "${resolution.fact}" for its attempt.`
            : "Released the merge lane latch.",
          metadata: { sequence, resolution },
        });

        if (resolution) {
          const move = resolutionMove(resolution);
          const changed = await tx.$executeRaw`UPDATE "QaReleaseMergeAttempt"
              SET "state" = ${move.to}, "outcome" = ${move.outcome},
                  "mergeCommitSha" = coalesce(${move.mergeCommitSha}, "mergeCommitSha"),
                  "lastAuditLogId" = ${auditLogId}
            WHERE "id" = ${resolution.attemptId} AND "state" = ${resolution.shownState}`;
          if (changed !== 1) throw new LatchReleaseRefused("attempt_changed");
        }

        await tx.$executeRaw`INSERT INTO "QaReleaseMergeLaneLatch" ("sequence", "latched", "reason", "attemptId", "auditLogId")
          VALUES (${sequence}, false, NULL, ${resolution?.attemptId ?? null}, ${auditLogId})`;
        return { released: true as const, sequence };
      },
      { maxWait: 5_000, timeout: RELEASE.prismaMs },
    );
  } catch (error) {
    if (error instanceof LatchReleaseRefused) return { released: false, reason: error.reason };
    throw error;
  }
}
