import "server-only";

import { Prisma } from "@prisma/client";

import { completeAmuxV22ReviewOnObservedMerge } from "@/lib/amux/reviewMergeObserved";
import {
  EngineeringAgentGitHubReadError,
  readEngineeringAgentPullObservation,
  type EngineeringAgentPullObservation,
} from "@/lib/engineeringAgentGitHubRead";
import { decideEngineeringAgentMergedPr, decideEngineeringAgentPrApproval } from "@/lib/engineeringAgentPrApprovalCore";
import {
  engineeringAgentBindingSnapshotSchema,
  engineeringAgentTransactionInAmux,
  openEngineeringAgentWorkItem,
  recordEngineeringAgentBindingObservation,
  runEngineeringAgentTransaction,
} from "@/lib/engineeringAgentStore";
import { prisma } from "@/lib/prisma";

/**
 * The approval observer (engineering-agent.md §9-10, version 5 item 1). Each
 * round it reads every current binding's pull request with the app's own
 * read-only token and:
 *
 * - while the pull request is open, records an approval the moment all seven
 *   conditions hold. Nothing else is recorded before the merge: "not yet
 *   reviewed" is read again next round, never frozen as a verdict.
 * - once it is merged, completes the AMUX card in the same transaction that
 *   records the merge -- if, and only if, the approval was recorded before the
 *   merge. A merge without that is not approved and goes to a person as a
 *   state mismatch, which halts the agent.
 *
 * A read that fails decides nothing; the binding is looked at again next round.
 */

// The observation writer: binding lock, switches, current row, update and its
// audit entry (four) -- nine, and three to spare.
const OBSERVATION_PRISMA_CALLS = 12;
const DEFAULT_LIMIT = 20;

export type EngineeringAgentPrObserverOutcome =
  | "approved"
  | "completed"
  | "merge_recorded"
  | "merged_without_approval"
  | "waiting"
  | "unreadable";

type Ports = {
  read: (prNumber: number) => Promise<EngineeringAgentPullObservation>;
  now: () => Date;
};

const livePorts: Ports = { read: (prNumber) => readEngineeringAgentPullObservation(prNumber), now: () => new Date() };

type Approval = { verdict: string; reviewId?: number; observedAt?: string } | null;

export async function observeEngineeringAgentPullRequests(
  input: { limit?: number } = {},
  ports: Ports = livePorts,
): Promise<Array<{ bindingId: string; outcome: EngineeringAgentPrObserverOutcome }>> {
  const bindings = await prisma.engineeringAgentBinding.findMany({
    where: { state: "open", supersededAt: null, mergeObservation: { equals: Prisma.AnyNull } },
    select: {
      id: true, runId: true, prNumber: true, verifiedHeadSha: true, snapshot: true, createdAt: true,
      approvalObservation: true,
      run: { select: { cardId: true, amuxAttemptId: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), 100),
  });
  const results: Array<{ bindingId: string; outcome: EngineeringAgentPrObserverOutcome }> = [];
  for (const binding of bindings) {
    let pull: EngineeringAgentPullObservation;
    try {
      pull = await ports.read(binding.prNumber);
    } catch (error) {
      if (!(error instanceof EngineeringAgentGitHubReadError)) throw error;
      results.push({ bindingId: binding.id, outcome: "unreadable" });
      continue;
    }
    const approval = binding.approvalObservation as Approval;
    const observedAt = ports.now().toISOString();

    if (!pull.merged) {
      if (pull.state !== "open" || approval !== null) {
        results.push({ bindingId: binding.id, outcome: "waiting" });
        continue;
      }
      const snapshot = engineeringAgentBindingSnapshotSchema.parse(binding.snapshot);
      const verdict = decideEngineeringAgentPrApproval({
        baseRef: pull.baseRef,
        headSha: pull.headSha,
        verifiedHeadSha: binding.verifiedHeadSha,
        requiredChecks: pull.requiredChecks,
        reviews: pull.reviews,
        snapshot: { ...snapshot, recordedAt: binding.createdAt },
        current: pull.diffDigest === null ? null : { baseSha: pull.baseSha, diffDigest: pull.diffDigest },
      });
      if (verdict.verdict !== "approved") {
        results.push({ bindingId: binding.id, outcome: "waiting" });
        continue;
      }
      const login = pull.reviews.find((review) => review.id === verdict.reviewId)?.login ?? "";
      await runEngineeringAgentTransaction(prisma, (tx) =>
        recordEngineeringAgentBindingObservation(tx, {
          bindingId: binding.id,
          kind: "approval",
          observation: {
            verdict: "approved",
            reviewId: verdict.reviewId,
            reviewCommitId: verdict.reviewCommitId,
            submittedAt: verdict.submittedAt.toISOString(),
            observedAt,
          },
          reviewer: { githubId: verdict.reviewerId, login },
        }),
      );
      results.push({ bindingId: binding.id, outcome: "approved" });
      continue;
    }

    const mergeObservation = {
      merged: true,
      mergeCommitSha: pull.mergeCommitSha,
      mergedAt: pull.mergedAt!.toISOString(),
      mergedByKind: pull.mergedByKind,
      observedAt,
    };
    const approvedBeforeMerge = approval?.verdict === "approved" && typeof approval.observedAt === "string" &&
      new Date(approval.observedAt).getTime() <= pull.mergedAt!.getTime();
    const merge = decideEngineeringAgentMergedPr({ merged: true, approvalRecordedBeforeMerge: approvedBeforeMerge });

    if (merge === "done") {
      const cardId = binding.run?.cardId ?? null;
      const attemptId = binding.run?.amuxAttemptId ?? null;
      if (cardId !== null && attemptId !== null && typeof approval?.reviewId === "number") {
        const completed = await completeAmuxV22ReviewOnObservedMerge(
          { taskId: cardId, attemptId, prNumber: binding.prNumber, mergeCommitSha: pull.mergeCommitSha!,
            approvalReviewId: approval.reviewId },
          {
            prismaCalls: OBSERVATION_PRISMA_CALLS,
            work: async (lent) => {
              await recordEngineeringAgentBindingObservation(engineeringAgentTransactionInAmux(lent), {
                bindingId: binding.id, kind: "merge", observation: mergeObservation,
              });
            },
          },
        );
        if (completed.completed) {
          results.push({ bindingId: binding.id, outcome: "completed" });
          continue;
        }
      }
      // Not a v22 implement card (or it has moved on): its review stays the
      // Admin console's; the merge is still recorded.
      await runEngineeringAgentTransaction(prisma, (tx) =>
        recordEngineeringAgentBindingObservation(tx, { bindingId: binding.id, kind: "merge", observation: mergeObservation }),
      );
      results.push({ bindingId: binding.id, outcome: "merge_recorded" });
      continue;
    }

    await runEngineeringAgentTransaction(prisma, async (tx) => {
      if (approval === null) {
        await recordEngineeringAgentBindingObservation(tx, {
          bindingId: binding.id,
          kind: "approval",
          observation: { verdict: "not_approved", reason: "merged_without_approval", observedAt },
          reviewer: null,
        });
      }
      await recordEngineeringAgentBindingObservation(tx, { bindingId: binding.id, kind: "merge", observation: mergeObservation });
      await openEngineeringAgentWorkItem(tx, {
        kind: "state_mismatch",
        causeKey: `merged_without_approval:${binding.id}`,
        runId: binding.runId,
        reason: "merged_without_approval",
      });
    });
    results.push({ bindingId: binding.id, outcome: "merged_without_approval" });
  }
  return results;
}
