import "server-only";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { AMUX_MAX_EXPECTED_REVISION } from "@/lib/amux/claimContract";
import {
  AMUX_DB_BOUNDARIES,
  amuxBoundaryWithAttachment,
  withAmuxDbBoundary,
  type AmuxAttachment,
} from "@/lib/amux/dbBoundary";

/** What an attachment to the review pull request record sees. */
export type AmuxReviewPullRequestFact = {
  taskId: string;
  /** The attempt whose review this number is for: the card's latest. */
  attemptId: string;
  prNumber: number;
  taskRevision: number;
};

export type AmuxReviewPullRequestRefusal =
  | "task_not_in_review"
  | "not_the_workers_review"
  | "review_pr_conflict";

type TaskRow = {
  id: string;
  status: string;
  owner: string | null;
  revision: number;
  archivedAt: Date | null;
  reviewPrNumber: number | null;
};

type AttemptRow = {
  id: string;
  worker: string;
  outcome: string | null;
  toStatus: string | null;
  endedAt: Date | null;
};

/**
 * Records the pull request a card's review is to judge
 * (development-agent-orchestration.md, Authority, version 12: "review 대상 PR
 * 번호의 기록"). Only for a card in `review` whose latest attempt the same
 * worker settled there; the number is written once, and writing the same
 * number again changes nothing. The caller names the attempt the number
 * belongs to, and it must be the card's latest: an earlier attempt's pull
 * request never lands on a later attempt's review. It opens no approval and
 * moves no status: the human review of the card stays AMUX's, and a later
 * board sync may still carry the number as it always has.
 */
export async function recordAmuxReviewPullRequest(
  input: { taskId: string; attemptId: string; worker: string; prNumber: number },
  attachment?: AmuxAttachment<AmuxReviewPullRequestFact>,
): Promise<
  | { recorded: true; taskRevision: number; changed: boolean }
  | { recorded: false; reason: AmuxReviewPullRequestRefusal }
> {
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0 || input.prNumber > 2_147_483_647) {
    throw new Error("AMUX review pull request number is invalid");
  }
  return withAmuxDbBoundary(
    amuxBoundaryWithAttachment(AMUX_DB_BOUNDARIES.reviewPullRequest, attachment),
    async (tx, context) => {
      const tasks = await tx.$queryRaw<TaskRow[]>`
        SELECT "id", "status", "owner", "revision", "archivedAt", "reviewPrNumber"
        FROM "AmuxWorkItem"
        WHERE "id" = ${input.taskId}
        FOR UPDATE
      `;
      const task = tasks[0];
      if (!task || task.status !== "review" || task.owner !== null || task.archivedAt !== null) {
        return { recorded: false as const, reason: "task_not_in_review" as const };
      }
      if (task.revision >= AMUX_MAX_EXPECTED_REVISION) {
        return { recorded: false as const, reason: "task_not_in_review" as const };
      }
      const attempts = await tx.$queryRaw<AttemptRow[]>`
        SELECT "id", "worker", "outcome", "toStatus", "endedAt"
        FROM "AmuxExecutionAttempt"
        WHERE "taskId" = ${input.taskId}
        ORDER BY "attemptNumber" DESC NULLS LAST, "startedAt" DESC, "id" DESC
        LIMIT 1
      `;
      const last = attempts[0];
      if (
        !last ||
        last.id !== input.attemptId ||
        last.worker !== input.worker ||
        last.endedAt === null ||
        last.outcome !== "succeeded" ||
        last.toStatus !== "review"
      ) {
        return { recorded: false as const, reason: "not_the_workers_review" as const };
      }
      if (task.reviewPrNumber !== null && task.reviewPrNumber !== input.prNumber) {
        return { recorded: false as const, reason: "review_pr_conflict" as const };
      }

      let taskRevision = task.revision;
      const changed = task.reviewPrNumber === null;
      if (changed) {
        const moved = await tx.amuxWorkItem.updateMany({
          where: { id: task.id, status: "review", owner: null, archivedAt: null, revision: task.revision, reviewPrNumber: null },
          data: { reviewPrNumber: input.prNumber, revision: { increment: 1 } },
        });
        if (moved.count !== 1) throw new Error("AMUX task changed while recording its review pull request");
        taskRevision = task.revision + 1;
        await writeSystemAuditLog({
          systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
          action: "amux.review.pull_request_recorded",
          targetType: "AmuxWorkItem",
          targetId: task.id,
          summary: `Recorded the review pull request of AMUX task ${task.id}.`,
          metadata: {
            pr_number: input.prNumber,
            worker: input.worker,
            previous_revision: task.revision,
            next_revision: taskRevision,
          },
          tx,
        });
      }

      if (attachment) {
        // The audit chain's lock comes before any row an attachment locks,
        // whether or not this call wrote an entry of its own.
        await takeAuditChainLock(context.attachedTransaction);
        await attachment.work(
          context.attachedTransaction,
          { taskId: task.id, attemptId: input.attemptId, prNumber: input.prNumber, taskRevision },
          { dbNow: context.dbNow },
        );
      }
      return { recorded: true as const, taskRevision, changed };
    },
  );
}
