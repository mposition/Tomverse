import type { Prisma } from "@prisma/client";

import { AMUX_V52_REVIEW_REJECTED_TWICE_REASON } from "./v52ReviewCore.ts";

/**
 * The Task's other rejected v52 reviews that count toward its next
 * disposition. An owner retry of a twice-rejected run starts the count again
 * (owner decision 2026-11-07), so that retry's first rejection returns to the
 * same grade once more instead of blocking at once. Rejections up to and
 * including the retried attempt are behind that owner decision; the attempt
 * budget still bounds how many runs there are.
 */
export async function amuxV52PriorReviewRejections(tx: Prisma.TransactionClient,
  taskId: string, attemptId: string): Promise<number> {
  const ownerRetried = await tx.amuxReviewProposal.findFirst({ where: {
    taskId, outcome: "retry",
    decision: { is: { outcome: "retry" } },
    attempt: { is: { outcome: "succeeded", toStatus: "blocked",
      reason: AMUX_V52_REVIEW_REJECTED_TWICE_REASON } },
  }, orderBy: { attempt: { attemptNumber: "desc" } },
  select: { attempt: { select: { attemptNumber: true } } } });
  const after = ownerRetried?.attempt?.attemptNumber ?? null;
  return tx.amuxV52ReviewRecord.count({ where: {
    taskId, verdict: "reject", attemptId: { not: attemptId },
    ...(after !== null ? { attempt: { attemptNumber: { gt: after } } } : {}),
  } });
}

/**
 * The job id of the Task's latest v52 review when that review rejected the
 * patch; the next run's prompt carries its findings. An owner retry of a
 * twice-rejected run therefore gets the second rejection's findings.
 */
export async function amuxV52ReviewFeedbackJobId(tx: Prisma.TransactionClient,
  taskId: string): Promise<string | undefined> {
  const prior = await tx.amuxV52ReviewRecord.findFirst({
    where: { taskId },
    orderBy: [{ createdAt: "desc" }, { attemptId: "desc" }],
    select: { jobId: true, verdict: true },
  });
  return prior?.verdict === "reject" ? prior.jobId ?? undefined : undefined;
}

/**
 * The attempt id when this exact attempt ended twice-rejected and holds its
 * own audited v52 `reject` record, else null. The owner review offers a
 * retry only on that evidence (amuxV22ReviewRetryHasVerifiedOutcome).
 */
export async function amuxV52RejectedTwiceReviewAttemptId(
  tx: Prisma.TransactionClient, taskId: string,
  attempt: { id: string; reason: string | null } | null,
): Promise<string | null> {
  if (!attempt || attempt.reason !== AMUX_V52_REVIEW_REJECTED_TWICE_REASON)
    return null;
  const record = await tx.amuxV52ReviewRecord.findFirst({ where: {
    attemptId: attempt.id, taskId, verdict: "reject",
    jobId: { not: null }, auditLog: { entryHash: { not: null } },
  }, select: { attemptId: true } });
  return record?.attemptId ?? null;
}
