import "server-only";

import { Prisma } from "@prisma/client";

import type { AmuxDmT2MergeObservedFacts } from "@/lib/amux/dmT2MergeRead";
import { readAmuxDmT2MergeEvidence } from "@/lib/amux/dmT2MergeService";
import { completeAmuxV22ReviewOnObservedMerge } from "@/lib/amux/reviewMergeObserved";
import {
  EngineeringAgentGitHubReadError,
  readEngineeringAgentPullObservation,
  type EngineeringAgentPullObservation,
} from "@/lib/engineeringAgentGitHubRead";
import {
  decideEngineeringAgentDmApprovedMerge, decideEngineeringAgentMergedPr, decideEngineeringAgentPrApproval,
} from "@/lib/engineeringAgentPrApprovalCore";
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
 *   records the merge -- if the approval was recorded before the merge, or the
 *   merge was an authorised approver's own, of the verified head into develop
 *   (owner decision 2026-11-12), or -- behind TOMVERSE_AMUX_DM_T2_MERGE -- the
 *   merge lane's own merge into develop of a pull request the Decision Maker
 *   approved before it, at the merged head and diff (owner decision
 *   2026-11-13). Any other merge is not approved and goes to a person as a
 *   state mismatch, which halts the agent.
 *
 * A read that fails decides nothing; the binding is looked at again next round.
 */

// The observation writer: binding lock, switches, current row, update and its
// audit entry (four) -- nine, and three to spare.
const OBSERVATION_PRISMA_CALLS = 12;
// Every round reads every binding it still has to watch, a page at a time, so
// none can be crowded out by older ones that wait. The owner's PR queue (engineering-agent.md §12)
// keeps the set small; the ceiling only stops a runaway round.
const PAGE_SIZE = 20;
const ROUND_CEILING = 200;

/**
 * The cause-key prefixes of the two mismatches this observer opens. The store
 * admits a prefix of at most 20 characters (CAUSE_KEY in
 * lib/engineeringAgentStore.ts). Until 2026-11-12 these were the reason codes
 * themselves, 22 and 23 characters long, so the store refused both: the
 * mismatch was never opened, its transaction rolled the merge observation
 * back, and the round ended in an error at that pull request every time
 * (production: nothing was observed after #3702 merged on 2026-11-10).
 */
export const ENGINEERING_AGENT_PR_FILE_MISMATCH_CAUSE = "pr_file_mismatch";
export const ENGINEERING_AGENT_UNAPPROVED_MERGE_CAUSE = "unapproved_merge";

export type EngineeringAgentPrObserverOutcome =
  | "approved"
  | "completed"
  | "merge_recorded"
  | "merged_without_approval"
  | "waiting"
  | "unreadable"
  | "pr_file_state_mismatch";

type Ports = {
  read: (prNumber: number) => Promise<EngineeringAgentPullObservation>;
  now: () => Date;
  /**
   * The Decision Maker's approval of a merged binding's pull request and the
   * merge lane's record of that merge (owner decision 2026-11-13), or null.
   * Evidence, not a gate: read whatever the switches say now, so a merge the
   * lane made while they were on is judged on what happened. Absent, the
   * second basis of approval is never consulted.
   */
  dmMerge?: (input: { bindingId: string; prNumber: number; headSha: string; mergeCommitSha: string }) =>
    Promise<AmuxDmT2MergeObservedFacts | null>;
};

const livePorts: Ports = {
  read: (prNumber) => readEngineeringAgentPullObservation(prNumber),
  now: () => new Date(),
  dmMerge: (input) => readAmuxDmT2MergeEvidence(input),
};

type Approval = { verdict: string; reviewId?: number; observedAt?: string } | null;

const BINDING_SELECT = {
  id: true, runId: true, prNumber: true, verifiedHeadSha: true, snapshot: true, createdAt: true,
  approvalObservation: true,
  run: { select: { cardId: true, amuxAttemptId: true } },
} as const;

async function* watchedBindings() {
  let cursor: string | null = null;
  for (let read = 0; read < ROUND_CEILING; read += PAGE_SIZE) {
    const page: Array<Prisma.EngineeringAgentBindingGetPayload<{ select: typeof BINDING_SELECT }>> =
      await prisma.engineeringAgentBinding.findMany({
        where: { state: "open", supersededAt: null, mergeObservation: { equals: Prisma.AnyNull } },
        select: BINDING_SELECT,
        orderBy: { id: "asc" },
        take: PAGE_SIZE,
        ...(cursor === null ? {} : { cursor: { id: cursor }, skip: 1 }),
      });
    yield* page;
    if (page.length < PAGE_SIZE) return;
    cursor = page[page.length - 1]!.id;
  }
}

/** One binding's outcome; `code` is the read error's own code when the round could not read it. */
export type EngineeringAgentPrObservation = {
  bindingId: string; outcome: EngineeringAgentPrObserverOutcome; code?: string };

export async function observeEngineeringAgentPullRequests(
  ports: Ports = livePorts,
): Promise<EngineeringAgentPrObservation[]> {
  const results: EngineeringAgentPrObservation[] = [];
  for await (const binding of watchedBindings()) {
    let pull: EngineeringAgentPullObservation;
    try {
      pull = await ports.read(binding.prNumber);
    } catch (error) {
      if (!(error instanceof EngineeringAgentGitHubReadError)) throw error;
      // The code only (never upstream text): a round that cannot read decides
      // nothing, and until 2026-11-12 it also said nothing, so a token that
      // lost a permission left merged pull requests unobserved for days.
      results.push({ bindingId: binding.id, outcome: "unreadable",
        ...(typeof error.code === "string" ? { code: error.code } : {}) });
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

    const approvedBeforeMerge = approval?.verdict === "approved" && typeof approval.observedAt === "string" &&
      new Date(approval.observedAt).getTime() <= pull.mergedAt!.getTime();
    // The merged head is the verified commit, or a later head whose pull
    // request diff is still the verified one: develop merged into the branch
    // (GitHub's "Update branch", or a session bringing it up to date) moves the
    // head without changing what the pull request changes. A diff that differs
    // in any byte, or that could not be read, is not verified (#3828,
    // 2026-11-13).
    const bound = engineeringAgentBindingSnapshotSchema.safeParse(binding.snapshot);
    const sameChange = pull.diffDigest !== null && bound.success &&
      pull.diffDigest === bound.data.diffDigest;
    let merge = decideEngineeringAgentMergedPr({ merged: true, approvalRecordedBeforeMerge: approvedBeforeMerge,
      mergedByApprover: pull.mergedByApprover === true, baseRef: pull.baseRef,
      headVerified: pull.headSha === binding.verifiedHeadSha || sameChange });
    // The second basis (owner decision 2026-11-13): the merge lane's own merge
    // into develop of a pull request the Decision Maker approved before it, at
    // exactly the merged head and diff. Consulted only for a merge that would
    // otherwise stop the agent; an unread approval, or a lane report still to
    // come, decides nothing this round.
    let dmSettlementId: string | null = null;
    if (merge === "merged_without_approval" && ports.dmMerge) {
      let facts: AmuxDmT2MergeObservedFacts | null;
      try {
        facts = await ports.dmMerge({ bindingId: binding.id, prNumber: binding.prNumber, headSha: pull.headSha,
          mergeCommitSha: pull.mergeCommitSha! });
      } catch {
        results.push({ bindingId: binding.id, outcome: "unreadable", code: "dm_approval_unreadable" });
        continue;
      }
      const dm = decideEngineeringAgentDmApprovedMerge({ baseRef: pull.baseRef, headSha: pull.headSha,
        diffDigest: pull.diffDigest, mergedAt: pull.mergedAt!, mergedByKind: pull.mergedByKind,
        approval: facts, laneMerge: facts?.laneMerge ?? null });
      if (dm === "waiting") {
        results.push({ bindingId: binding.id, outcome: "waiting" });
        continue;
      }
      if (dm === "done") {
        merge = "done";
        dmSettlementId = facts!.settlementId;
      }
    }
    // No review was recorded first: the approver's own merge, or the Decision Maker's approval, is the approval.
    const approvedByMerge = merge === "done" && !approvedBeforeMerge && dmSettlementId === null;
    const mergeObservation = {
      merged: true,
      mergeCommitSha: pull.mergeCommitSha,
      mergedAt: pull.mergedAt!.toISOString(),
      mergedByKind: pull.mergedByKind,
      observedAt,
    };
    const mergeRecord = { bindingId: binding.id, kind: "merge" as const, observation: mergeObservation,
      ...(approvedByMerge ? { approvedByMerge: true as const } : {}),
      ...(dmSettlementId !== null ? { approvedByDm: true as const } : {}) };

    if (merge === "done") {
      const cardId = binding.run?.cardId ?? null;
      const attemptId = binding.run?.amuxAttemptId ?? null;
      const approvalReviewId = approvedByMerge || dmSettlementId !== null ? null :
        typeof approval?.reviewId === "number" ? approval.reviewId : undefined;
      if (cardId !== null && attemptId !== null && approvalReviewId !== undefined) {
        const completed = await completeAmuxV22ReviewOnObservedMerge(
          { taskId: cardId, attemptId, prNumber: binding.prNumber, mergeCommitSha: pull.mergeCommitSha!,
            approvalReviewId, changedFiles: pull.changedFiles ?? null, bindingId: binding.id,
            ...(dmSettlementId !== null ? { dmSettlementId } : {}) },
          {
            prismaCalls: OBSERVATION_PRISMA_CALLS,
            work: async (lent) => {
              await recordEngineeringAgentBindingObservation(engineeringAgentTransactionInAmux(lent), mergeRecord);
            },
          },
        );
        if (completed.completed) {
          results.push({ bindingId: binding.id, outcome: "completed" });
          continue;
        }
        if (completed.reason === "pr_file_state_mismatch") {
          await runEngineeringAgentTransaction(prisma, async (tx) => {
            await recordEngineeringAgentBindingObservation(tx, mergeRecord);
            await openEngineeringAgentWorkItem(tx, {
              kind: "state_mismatch",
              causeKey: `${ENGINEERING_AGENT_PR_FILE_MISMATCH_CAUSE}:${binding.id}`,
              runId: binding.runId,
              reason: "pr_file_state_mismatch",
            });
          });
          results.push({ bindingId: binding.id, outcome: "pr_file_state_mismatch" });
          continue;
        }
      }
      // Not a v22 implement card (or it has moved on): its review stays the
      // Admin console's; the merge is still recorded.
      await runEngineeringAgentTransaction(prisma, (tx) =>
        recordEngineeringAgentBindingObservation(tx, mergeRecord),
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
      await recordEngineeringAgentBindingObservation(tx, mergeRecord);
      await openEngineeringAgentWorkItem(tx, {
        kind: "state_mismatch",
        causeKey: `${ENGINEERING_AGENT_UNAPPROVED_MERGE_CAUSE}:${binding.id}`,
        runId: binding.runId,
        reason: "merged_without_approval",
      });
    });
    results.push({ bindingId: binding.id, outcome: "merged_without_approval" });
  }
  return results;
}
