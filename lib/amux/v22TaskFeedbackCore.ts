/** Read-only outcome projection. Unknown observations must never become zero. */
import type { AmuxV22Observation } from "./v22OutcomeObservationCore.ts";

/** Both Story and node rollups use the same active-card boundary as the
 * hierarchy list; historical archived cards remain in the audit, not totals. */
export function amuxFeedbackTaskWhere(parent: { kind: "story" | "node";
  id: string }, featureIds: string[]) {
  return parent.kind === "story" ?
    { cardType: "task" as const, parentStoryCardId: parent.id,
      archivedAt: null } :
    { cardType: "task" as const, parentFeatureNodeId: { in: featureIds },
      archivedAt: null };
}

export type AmuxFeedbackAttempt = {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  outcome: string | null;
  settledCostMicrousd: bigint | null;
  costConfirmed: boolean;
};

export type AmuxFeedbackUsage = {
  attemptId: string | null;
  completeness: string;
  inputTokens: bigint | null;
  outputTokens: bigint | null;
  cacheReadInputTokens: bigint | null;
  cacheCreationInputTokens: bigint | null;
  projectedApiCostMicrousd: bigint | null;
  actualApiCostMicrousd: bigint | null;
};

export type AmuxFeedbackDecision = {
  id: string;
  outcome: string;
  decidedAt: Date;
};

export type AmuxFeedbackTask = {
  id: string;
  revision: number;
  status: string;
  createdAt: Date;
  effortPoints: number;
  estimatedCostMicrousd: bigint | null;
  approvedCeilingMicrousd?: bigint | null;
  attempts: AmuxFeedbackAttempt[];
  usage: AmuxFeedbackUsage[];
  decisions: AmuxFeedbackDecision[];
  observations?: Array<AmuxV22Observation & { taskRevision: number }>;
};

const sumKnown = (values: Array<bigint | null>): string | null =>
  values.every((value) => value !== null) ?
    values.reduce<bigint>((total, value) => total + (value ?? BigInt(0)), BigInt(0)).toString() : null;

export function projectAmuxTaskFeedback(task: AmuxFeedbackTask) {
  const attempts = [...task.attempts].sort((a, b) =>
    a.startedAt.getTime() - b.startedAt.getTime());
  const decisions = [...task.decisions].sort((a, b) =>
    a.decidedAt.getTime() - b.decidedAt.getTime());
  const observations = (task.observations ?? []).filter((item) =>
    item.taskRevision === task.revision).sort((a, b) =>
    Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const checks = observations.filter((item) =>
    item.kind === "checks").at(-1) ?? null;
  const independentReview = observations.filter((item) =>
    item.kind === "independent_review").at(-1) ?? null;
  const regression = observations.filter((item) =>
    item.kind === "post_deploy_regression").at(-1) ?? null;
  const userOutcome = observations.filter((item) =>
    item.kind === "user_outcome").at(-1) ?? null;
  const estimateRevision = observations.filter((item) =>
    item.kind === "estimate_revision").at(-1) ?? null;
  const allAttemptsClosed = attempts.length > 0 && attempts.every((attempt) =>
    attempt.endedAt !== null && attempt.outcome !== null &&
    attempt.endedAt.getTime() >= attempt.startedAt.getTime());
  const executionMs = attempts.length > 0 && allAttemptsClosed ? attempts.reduce((total, attempt) =>
    total + (attempt.endedAt!.getTime() - attempt.startedAt.getTime()), 0) : null;
  const lastDecision = decisions.at(-1) ?? null;
  const cycleMs = lastDecision &&
    lastDecision.decidedAt.getTime() >= task.createdAt.getTime() ?
    lastDecision.decidedAt.getTime() - task.createdAt.getTime() : null;
  const completeUsage = attempts.length > 0 &&
    attempts.every((attempt) => task.usage.some((event) =>
      event.attemptId === attempt.id)) && task.usage.every((event) =>
    event.completeness === "reported_complete" &&
    event.attemptId !== null && attempts.some((attempt) => attempt.id === event.attemptId));
  const tokensKnown = completeUsage && task.usage.every((event) =>
    event.inputTokens !== null && event.outputTokens !== null &&
    event.cacheReadInputTokens !== null && event.cacheCreationInputTokens !== null);
  const usage = tokensKnown ? {
    inputTokens: sumKnown(task.usage.map((event) => event.inputTokens)),
    outputTokens: sumKnown(task.usage.map((event) => event.outputTokens)),
    cacheReadInputTokens: sumKnown(task.usage.map((event) => event.cacheReadInputTokens)),
    cacheCreationInputTokens: sumKnown(task.usage.map((event) => event.cacheCreationInputTokens)),
  } : null;
  const projectedApiCostMicrousd = completeUsage ?
    sumKnown(task.usage.map((event) => event.projectedApiCostMicrousd)) : null;
  const actualApiCostMicrousd = completeUsage ?
    sumKnown(task.usage.map((event) => event.actualApiCostMicrousd)) : null;
  const settledCostMicrousd = attempts.length > 0 && attempts.every((attempt) =>
    attempt.costConfirmed && attempt.settledCostMicrousd !== null) ?
    sumKnown(attempts.map((attempt) => attempt.settledCostMicrousd)) : null;
  return {
    taskId: task.id,
    status: task.status,
    expected: { effortPoints: task.effortPoints,
      estimatedCostMicrousd: task.estimatedCostMicrousd?.toString() ?? null,
      approvedCeilingMicrousd: task.approvedCeilingMicrousd?.toString() ?? null },
    observed: {
      attemptCount: attempts.length,
      executionMs,
      cycleMs,
      settledCostMicrousd,
      usage,
      projectedApiCostMicrousd,
      actualApiCostMicrousd,
      checks,
      independentReview,
      // These are not inferable from a successful PR, worker result, or review.
      postDeployRegression: regression,
      userOutcome,
      estimateRevision,
    },
    ownerDecisions: decisions.map((decision) => ({ id: decision.id,
      outcome: decision.outcome, decidedAt: decision.decidedAt.toISOString() })),
    evidence: {
      completeExecution: allAttemptsClosed,
      completeUsage: tokensKnown,
      costConfirmed: settledCostMicrousd !== null,
      subjectiveOutcomeRecorded: regression !== null && userOutcome !== null,
    },
  };
}

export type AmuxTaskFeedbackProjection = ReturnType<typeof projectAmuxTaskFeedback>;

/** Aggregate only complete values; a missing child never disappears into zero. */
export function rollupAmuxTaskFeedback(tasks: AmuxTaskFeedbackProjection[]) {
  const sumNumber = (pick: (task: AmuxTaskFeedbackProjection) => number | null) => {
    const values = tasks.map(pick);
    return values.every((value) => value !== null) ?
      values.reduce<number>((total, value) => total + (value ?? 0), 0) : null;
  };
  const sumMoney = (pick: (task: AmuxTaskFeedbackProjection) => string | null) =>
    sumKnown(tasks.map((task) => {
      const value = pick(task);
      return value === null ? null : BigInt(value);
    }));
  return {
    taskCount: tasks.length,
    doneCount: tasks.filter((task) => task.status === "done").length,
    attemptCount: tasks.reduce((total, task) =>
      total + task.observed.attemptCount, 0),
    executionMs: sumNumber((task) => task.observed.executionMs),
    cycleMs: sumNumber((task) => task.observed.cycleMs),
    estimatedCostMicrousd: sumMoney((task) => task.expected.estimatedCostMicrousd),
    approvedCeilingMicrousd: sumMoney((task) => task.expected.approvedCeilingMicrousd),
    settledCostMicrousd: sumMoney((task) => task.observed.settledCostMicrousd),
    incompleteUsageCount: tasks.filter((task) => !task.evidence.completeUsage).length,
    checkFindings: sumNumber((task) =>
      task.observed.checks?.findingCount ?? null),
    independentReviewFindings: sumNumber((task) =>
      task.observed.independentReview?.findingCount ?? null),
    subjectiveOutcomeMissingCount: tasks.filter((task) =>
      !task.evidence.subjectiveOutcomeRecorded).length,
  };
}

/** The v4 Task registration keeps its approved maximum in the immutable
 * confirmation snapshot, not the legacy estimatedCostMicrousd column. */
export function readAmuxV4ApprovedCeiling(snapshot: unknown): bigint | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
    return null;
  const card = (snapshot as Record<string, unknown>).card;
  if (!card || typeof card !== "object" || Array.isArray(card)) return null;
  const task = (card as Record<string, unknown>).task;
  if (!task || typeof task !== "object" || Array.isArray(task)) return null;
  const receipt = (task as Record<string, unknown>).costReceipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
    return null;
  const value = (receipt as Record<string, unknown>).ceilingMicroUsd;
  return typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value) &&
    BigInt(value) <= BigInt("9223372036854775807") ? BigInt(value) : null;
}
