import "server-only";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { AMUX_MAX_EXPECTED_REVISION } from "@/lib/amux/claimContract";
import { AMUX_DEFAULT_REVIEW_SPECIALTY } from "@/lib/amux/humanReviewCore";
import {
  AMUX_DB_BOUNDARIES,
  amuxBoundaryWithAttachment,
  withAmuxDbBoundary,
  type AmuxAttachment,
} from "@/lib/amux/dbBoundary";
import { amuxV22TaskWritesPatch } from "@/lib/amux/v22WorkerClaimCore";

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
  | "review_not_required"
  | "not_the_workers_review"
  | "review_pr_conflict";

type TaskRow = {
  id: string;
  status: string;
  owner: string | null;
  revision: number;
  archivedAt: Date | null;
  requiresHumanReview: boolean;
  reviewSpecialty: string | null;
  reviewPrNumber: number | null;
  sourceSystem: string | null;
  cardType: string | null;
  taskRole: string | null;
};

/**
 * A v22 `implement` Task: the card the engineering publisher opens a pull
 * request for after its attempt settled to `review`, and the one an observed
 * approval and merge completes (lib/amux/reviewMergeObserved.ts). Its row can
 * never carry a review pull request number: the v4 plaintext exclusion keeps
 * `reviewSpecialty` null, the human review shape check then keeps
 * `requiresHumanReview` false, and the review PR check needs it true.
 */
export const amuxV22ImplementTask = (task: Pick<TaskRow, "sourceSystem" | "cardType" | "taskRole">) =>
  task.sourceSystem === "admin-idea-v4" && task.cardType === "task" && amuxV22TaskWritesPatch(task.taskRole);

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
 *
 * A card that reached review without asking for one (a v22 card, whose
 * attempt settles through its own path) is marked for human review when its
 * first number is written, by the same rule the attempt settlement uses:
 * AmuxWorkItem_review_pr_check needs requiresHumanReview with a stored number,
 * and AmuxWorkItem_human_review_shape_check needs a specialty with that flag,
 * so the default specialty fills a missing one and an existing one is kept.
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
      // Audit chain before the Task row (lib/adminAudit.ts takeAuditChainLock):
      // a review proposal on this card holds the chain while it waits for it.
      await takeAuditChainLock(tx);
      const tasks = await tx.$queryRaw<TaskRow[]>`
        SELECT "id", "status", "owner", "revision", "archivedAt", "requiresHumanReview", "reviewSpecialty", "reviewPrNumber",
               "sourceSystem", "cardType", "taskRole"
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
      // A v22 implement Task is reviewed through its pull request, but its row
      // cannot hold the number (amuxV22ImplementTask). The attachment's
      // binding holds it instead -- the engineering publisher's, written in
      // this transaction -- and the merge observer completes the card from
      // that binding. Refusing it opened a state mismatch for every pull
      // request the publisher opened, which halted the whole agent until a
      // person closed it (2026-10-30 #3147, 2026-11-11 #3702). Any other card
      // is marked for human review when its first number is written.
      const unmarkedV22Implement = !task.requiresHumanReview && amuxV22ImplementTask(task);
      // Without an attachment nothing would hold the number, and the row cannot.
      if (unmarkedV22Implement && attachment === undefined) {
        return { recorded: false as const, reason: "review_not_required" as const };
      }
      const heldByAttachment = unmarkedV22Implement;
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
      const changed = task.reviewPrNumber === null && !heldByAttachment;
      if (heldByAttachment) {
        // The card itself does not change; the entry says which pull request
        // its review is now waiting on, and that the binding holds it.
        await writeSystemAuditLog({
          systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
          action: "amux.review.pull_request_recorded",
          targetType: "AmuxWorkItem",
          targetId: task.id,
          summary: `Recorded the review pull request of AMUX task ${task.id} on its engineering binding.`,
          metadata: {
            pr_number: input.prNumber,
            worker: input.worker,
            attempt_id: input.attemptId,
            held_by: "engineering_binding",
            previous_revision: task.revision,
            next_revision: task.revision,
          },
          tx,
        });
      }
      if (changed) {
        // The number is only written once, so only that write can mark the card.
        const marksHumanReview = !task.requiresHumanReview;
        const moved = await tx.amuxWorkItem.updateMany({
          where: { id: task.id, status: "review", owner: null, archivedAt: null, revision: task.revision, reviewPrNumber: null },
          data: {
            reviewPrNumber: input.prNumber,
            ...(marksHumanReview
              ? { requiresHumanReview: true, reviewSpecialty: task.reviewSpecialty ?? AMUX_DEFAULT_REVIEW_SPECIALTY }
              : {}),
            revision: { increment: 1 },
          },
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
            marked_human_review: marksHumanReview,
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
