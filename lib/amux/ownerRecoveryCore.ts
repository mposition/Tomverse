export type AmuxOwnerRecoveryReason =
  | "local_card_done"
  | "local_card_closed"
  | "execution_lease_expired"
  | "outcome_unknown"
  | "evidence_missing"
  | "terminal_recorded";

export type AmuxOwnerRecoveryOutputState =
  | "verified"
  | "unverified"
  | "missing";

export type AmuxOwnerRecoveryPreparation = {
  reason: AmuxOwnerRecoveryReason;
  assignmentConnected: boolean;
  executionOutcomeKnown: boolean;
  outputState: AmuxOwnerRecoveryOutputState;
  decisionContextReady: boolean;
  approvalExecutionSourceReady: boolean;
  retryPreviewReady: boolean;
  missingEvidence: Array<"assignment" | "execution_outcome" | "worker_output">;
};

type OwnerRecoveryInput = {
  taskStatus: string;
  taskRevision: number;
  escalationReason: string | null;
  lastAttemptReason: string | null;
  lastAttemptTaskRevision: number | null;
  lastAttemptOutcome: string | null;
  lastAttemptToStatus: string | null;
  lastAttemptEndedAt: string | null;
  assignmentConnected: boolean;
  workerReportConnected: boolean;
  workerReportVerified: boolean;
  artifactConnected: boolean;
  serverAllowsRetry: boolean;
};

const exactReason = (input: OwnerRecoveryInput) => {
  const reasons = [input.escalationReason, input.lastAttemptReason];
  if (reasons.includes("execution_lease_expired"))
    return "execution_lease_expired" as const;
  if (reasons.includes("local_card_done")) return "local_card_done" as const;
  if (reasons.includes("local_card_closed")) return "local_card_closed" as const;
  if (reasons.includes("outcome_unknown") ||
      reasons.includes("usage_outcome_unknown") ||
      input.lastAttemptOutcome === "expired" ||
      input.lastAttemptOutcome === "outcome_unknown")
    return "outcome_unknown" as const;
  return null;
};

const isAttemptBudgetReason = (input: OwnerRecoveryInput) =>
  input.escalationReason === "attempt_budget_exhausted" ||
  input.lastAttemptReason === "attempt_budget_exhausted" ||
  // The v22 settlement path stores the execution-budget core's closed enum
  // value on the attempt while its escalation normalizes the same condition.
  input.lastAttemptReason === "attempts";

/**
 * Produces display-only recovery facts from the exact protected-review
 * projection. It neither grants an outcome nor claims that a recovery job is
 * running. Server `allowed_outcomes` and the existing proposal writer remain
 * the only authority for a decision.
 */
export const amuxOwnerRecoveryPreparation = (
  input: OwnerRecoveryInput,
): AmuxOwnerRecoveryPreparation => {
  const ambiguousReason = exactReason(input);
  const protectedTerminalOutcome = input.lastAttemptEndedAt !== null && (
    (input.lastAttemptOutcome === "succeeded" &&
      (input.lastAttemptToStatus === "review" || input.lastAttemptToStatus === "done")) ||
    (input.lastAttemptOutcome === "failed" && input.lastAttemptToStatus === "todo") ||
    (input.lastAttemptOutcome === "failed" &&
      input.lastAttemptToStatus === "blocked" && isAttemptBudgetReason(input)) ||
    (input.lastAttemptOutcome === "blocked" && input.lastAttemptToStatus === "blocked")
  );
  const executionOutcomeKnown = ambiguousReason === null && protectedTerminalOutcome;
  const noAttemptHumanReviewContext =
    input.taskStatus === "blocked" &&
    input.escalationReason === "human_review_required" &&
    input.lastAttemptReason === null &&
    input.lastAttemptTaskRevision === null &&
    input.lastAttemptOutcome === null &&
    input.lastAttemptToStatus === null &&
    input.lastAttemptEndedAt === null;
  const outputState: AmuxOwnerRecoveryOutputState = input.artifactConnected ||
    (input.workerReportConnected && input.workerReportVerified)
    ? "verified"
    : input.workerReportConnected
      ? "unverified"
      : "missing";
  const missingEvidence: AmuxOwnerRecoveryPreparation["missingEvidence"] = [];
  if (!input.assignmentConnected) missingEvidence.push("assignment");
  if (!executionOutcomeKnown) missingEvidence.push("execution_outcome");
  if (outputState === "missing") missingEvidence.push("worker_output");

  // A server-authorized no-attempt human review may still preserve a meaningful
  // Block decision. It does not say that no worker ran and can never prepare a
  // retry or approval; those still require a protected terminal execution.
  const decisionContextReady = input.assignmentConnected &&
    (executionOutcomeKnown || noAttemptHumanReviewContext);
  const approvalExecutionSourceReady = input.assignmentConnected &&
    executionOutcomeKnown && input.taskStatus === "review" &&
    input.lastAttemptOutcome === "succeeded" &&
    input.lastAttemptToStatus === "review" &&
    Number.isSafeInteger(input.taskRevision) &&
    Number.isSafeInteger(input.lastAttemptTaskRevision) &&
    (input.lastAttemptTaskRevision as number) < input.taskRevision;
  const retryPreviewReady = input.serverAllowsRetry &&
    executionOutcomeKnown && decisionContextReady && outputState === "verified";

  return {
    reason: ambiguousReason ?? (!executionOutcomeKnown || !input.assignmentConnected
      ? "evidence_missing"
      : "terminal_recorded"),
    assignmentConnected: input.assignmentConnected,
    executionOutcomeKnown,
    outputState,
    decisionContextReady,
    approvalExecutionSourceReady,
    retryPreviewReady,
    missingEvidence,
  };
};
