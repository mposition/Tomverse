import "server-only";

import { amuxV22TaskWritesPatch } from "@/lib/amux/v22WorkerClaimCore";
import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { AMUX_MAX_EXPECTED_REVISION } from "@/lib/amux/claimContract";
import { decideAmuxV52ChangedPaths } from "@/lib/amux/executionGradeCore";
import {
  AMUX_DB_BOUNDARIES,
  amuxBoundaryWithAttachment,
  withAmuxDbBoundary,
  type AmuxAttachment,
} from "@/lib/amux/dbBoundary";

/** Who closes a review escalation when GitHub, not the Admin console, settled it. */
export const AMUX_MERGE_OBSERVER_RESOLVER = "system:amux-github-merge-observer";

export type AmuxReviewMergeObservedFact = {
  taskId: string;
  attemptId: string;
  prNumber: number;
  taskRevision: number;
};

export type AmuxReviewMergeObservedRefusal =
  | "task_not_in_review"
  | "not_a_v22_implement_task"
  | "review_pr_mismatch"
  | "not_the_latest_attempt"
  | "pr_file_state_mismatch";

type TaskRow = {
  id: string;
  status: string;
  owner: string | null;
  revision: number;
  archivedAt: Date | null;
  sourceSystem: string | null;
  cardType: string | null;
  taskRole: string | null;
  executionGrade: string | null;
  reviewPrNumber: number | null;
};

type AttemptRow = {
  id: string;
  outcome: string | null;
  toStatus: string | null;
  endedAt: Date | null;
  v22AssignmentId: string | null;
};

/**
 * Completes a v22 `implement` Task whose review pull request the app observed
 * approved by an authorised person and then merged (engineering-agent.md
 * version 5, item 1; orchestration policy version 49), or merged by an
 * authorised approver themselves (owner decision 2026-11-12:
 * decideEngineeringAgentMergedPr). The caller has already judged the approval
 * and observed the merge; this writer only moves the card it names: `review`
 * to `done`, `v4TerminalAt` on the DB clock, and the open review escalation
 * resolved as approved, with one system audit entry. The number must be the
 * one recorded on the card for its latest attempt, so a merge of some other
 * pull request never completes it. A v22 implement Task's row cannot hold the
 * number (lib/amux/reviewPullRequest.ts amuxV22ImplementTask); for it the
 * caller names the engineering binding whose approval and merge it observed,
 * and that binding must still be the current one for this PR on a run of the
 * card's latest attempt, read under its row lock.
 */
export async function completeAmuxV22ReviewOnObservedMerge(
  input: {
    taskId: string;
    attemptId: string;
    prNumber: number;
    mergeCommitSha: string;
    /** The approval review observed before the merge; null when the approver's own merge is the approval. */
    approvalReviewId: number | null;
    changedFiles?: string[] | null;
    /** The engineering binding whose approval and merge the caller observed. */
    bindingId?: string | null;
  },
  attachment?: AmuxAttachment<AmuxReviewMergeObservedFact>,
): Promise<
  | { completed: true; taskRevision: number }
  | { completed: false; reason: AmuxReviewMergeObservedRefusal }
> {
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0 || input.prNumber > 2_147_483_647) {
    throw new Error("AMUX review pull request number is invalid");
  }
  if (!/^[0-9a-f]{40}$/.test(input.mergeCommitSha)) throw new Error("AMUX merge commit SHA is invalid");
  if (input.approvalReviewId !== null &&
      (!Number.isSafeInteger(input.approvalReviewId) || input.approvalReviewId <= 0)) {
    throw new Error("AMUX approval review id is invalid");
  }
  const approvedBy = input.approvalReviewId === null ?
    "an authorised approver's own merge" : `GitHub approval review ${input.approvalReviewId}`;
  const boundary = amuxBoundaryWithAttachment(
    AMUX_DB_BOUNDARIES.reviewMergeObserved, attachment);
  return withAmuxDbBoundary(
    // +2 the assignment and its audit entry; +1 the binding that holds a v22
    // implement Task's review pull request number.
    { ...boundary, prismaCallCeiling: boundary.prismaCallCeiling + 3 },
    async (tx, context) => {
      // The audit chain's lock comes before the card's row lock, as in the
      // writers that read the card after taking it; the other order can wait
      // in a cycle with them.
      await takeAuditChainLock(tx);
      const tasks = await tx.$queryRaw<TaskRow[]>`
        SELECT "id", "status", "owner", "revision", "archivedAt", "sourceSystem",
               "cardType", "taskRole", "executionGrade", "reviewPrNumber"
        FROM "AmuxWorkItem"
        WHERE "id" = ${input.taskId}
        FOR UPDATE
      `;
      const task = tasks[0];
      if (!task || task.status !== "review" || task.owner !== null || task.archivedAt !== null ||
          task.revision >= AMUX_MAX_EXPECTED_REVISION) {
        return { completed: false as const, reason: "task_not_in_review" as const };
      }
      if (task.sourceSystem !== "admin-idea-v4" || task.cardType !== "task" || !amuxV22TaskWritesPatch(task.taskRole)) {
        return { completed: false as const, reason: "not_a_v22_implement_task" as const };
      }
      // A v22 implement Task's row cannot hold its review pull request number
      // (lib/amux/reviewPullRequest.ts amuxV22ImplementTask), so the number
      // is the one the engineering binding of this card's attempt holds:
      // written with the publisher's result, in the same transaction as the
      // review record. It must be the very binding whose approval the caller
      // observed, still current, locked here after the card (engineering rows
      // come after every AMUX row): a re-bind under a new snapshot supersedes
      // it and voids that approval (engineering-agent.md §9-10). A merge of
      // any other pull request still completes nothing.
      let heldByBinding: string | null = null;
      if (task.reviewPrNumber !== input.prNumber) {
        const bound = task.reviewPrNumber === null && typeof input.bindingId === "string"
          ? await tx.$queryRaw<Array<{ id: string }>>`
              SELECT b."id" FROM "EngineeringAgentBinding" b
              JOIN "EngineeringAgentRun" r ON r."id" = b."runId"
              WHERE b."id" = ${input.bindingId} AND b."prNumber" = ${input.prNumber}
                AND b."supersededAt" IS NULL AND b."currentPrNumber" = ${input.prNumber}
                AND r."cardId" = ${input.taskId} AND r."amuxAttemptId" = ${input.attemptId}
              FOR UPDATE OF b
            `
          : [];
        heldByBinding = bound[0]?.id ?? null;
        if (heldByBinding === null) {
          return { completed: false as const, reason: "review_pr_mismatch" as const };
        }
      }
      const attempts = await tx.$queryRaw<AttemptRow[]>`
        SELECT "id", "outcome", "toStatus", "endedAt", "v22AssignmentId"
        FROM "AmuxExecutionAttempt"
        WHERE "taskId" = ${input.taskId}
        ORDER BY "attemptNumber" DESC NULLS LAST, "startedAt" DESC, "id" DESC
        LIMIT 1
      `;
      const last = attempts[0];
      if (!last || last.id !== input.attemptId || last.endedAt === null || last.outcome !== "succeeded" ||
          last.toStatus !== "review" || last.v22AssignmentId === null) {
        return { completed: false as const, reason: "not_the_latest_attempt" as const };
      }
      const assignment = await tx.amuxV22WorkerAssignment.findUnique({
        where: { id: last.v22AssignmentId },
        select: { authorizationAuditLogId: true, grade: true },
      });
      const authorization = assignment ? await tx.adminAuditLog.findUnique({
        where: { id: assignment.authorizationAuditLogId },
        select: { entryHash: true, action: true, targetId: true,
          metadata: true },
      }) : null;
      const authorizationVerified = !!authorization?.entryHash &&
        authorization.action === "amux.v22.worker.assigned" &&
        authorization.targetId === last.v22AssignmentId;
      const metadata = authorization?.metadata;
      const gradeGuard = !!metadata && typeof metadata === "object" &&
        !Array.isArray(metadata) &&
        (metadata as Record<string, unknown>).v52GradeRouting === true;
      if (gradeGuard && (!assignment || !authorizationVerified))
        return { completed: false as const,
          reason: "pr_file_state_mismatch" as const };
      if (gradeGuard && assignment &&
          (assignment.grade !== task.executionGrade ||
          decideAmuxV52ChangedPaths(assignment.grade,
            input.changedFiles) !== "pass"))
        return { completed: false as const,
          reason: "pr_file_state_mismatch" as const };

      const moved = await tx.amuxWorkItem.updateMany({
        where: { id: task.id, status: "review", owner: null, archivedAt: null, revision: task.revision,
          reviewPrNumber: task.reviewPrNumber },
        // The card becomes terminal here, once, on the DB clock; dependents,
        // result retention and content purge all wait on this timestamp.
        data: { status: "done", revision: { increment: 1 }, v4TerminalAt: context.dbNow },
      });
      if (moved.count !== 1) throw new Error("AMUX task changed while completing its observed merge");
      const taskRevision = task.revision + 1;
      await tx.amuxHumanEscalation.updateMany({
        where: { taskId: task.id, status: { in: ["open", "acknowledged"] } },
        data: {
          status: "resolved",
          resolutionOutcome: "approve",
          resolution: `${approvedBy[0]!.toUpperCase()}${approvedBy.slice(1)} and merge ${input.mergeCommitSha} observed.`,
          resolvedById: AMUX_MERGE_OBSERVER_RESOLVER,
          resolvedByEmail: null,
          resolvedAt: context.dbNow,
        },
      });
      await writeSystemAuditLog({
        systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
        action: "amux.v22.review.merge_observed",
        targetType: "AmuxWorkItem",
        targetId: task.id,
        summary: `Completed AMUX task ${task.id} on its observed approval and merge.`,
        metadata: {
          attempt_id: input.attemptId,
          pr_number: input.prNumber,
          merge_commit_sha: input.mergeCommitSha,
          ...(input.approvalReviewId === null ? { approval_basis: "approver_merge" } :
            { approval_review_id: input.approvalReviewId }),
          ...(heldByBinding === null ? {} : { binding_id: heldByBinding }),
          previous_revision: task.revision,
          next_revision: taskRevision,
        },
        tx,
      });

      if (attachment) {
        // The audit chain's lock, taken first above, already precedes any row
        // an attachment locks.
        await attachment.work(
          context.attachedTransaction,
          { taskId: task.id, attemptId: input.attemptId, prNumber: input.prNumber, taskRevision },
          { dbNow: context.dbNow },
        );
      }
      return { completed: true as const, taskRevision };
    },
  );
}
