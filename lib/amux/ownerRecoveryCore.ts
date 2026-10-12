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
  retryPreviewReady: boolean;
  missingEvidence: Array<"assignment" | "execution_outcome" | "worker_output">;
};

type OwnerRecoveryInput = {
  escalationReason: string | null;
  lastAttemptReason: string | null;
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

/**
 * Produces display-only recovery facts from the exact protected-review
 * projection. It neither grants an outcome nor claims that a recovery job is
 * running. Server `allowed_outcomes` and the existing proposal writer remain
 * the only authority for a retry.
 */
export const amuxOwnerRecoveryPreparation = (
  input: OwnerRecoveryInput,
): AmuxOwnerRecoveryPreparation => {
  const ambiguousReason = exactReason(input);
  const protectedTerminalOutcome = input.lastAttemptEndedAt !== null && (
    (input.lastAttemptOutcome === "succeeded" &&
      (input.lastAttemptToStatus === "review" || input.lastAttemptToStatus === "done")) ||
    (input.lastAttemptOutcome === "failed" && input.lastAttemptToStatus === "todo") ||
    (input.lastAttemptOutcome === "blocked" && input.lastAttemptToStatus === "blocked")
  );
  const executionOutcomeKnown = ambiguousReason === null && protectedTerminalOutcome;
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

  // Every task decision needs the exact original work and a real protected
  // terminal outcome. Result evidence remains a separate approve/retry gate:
  // the server may still permit Block for a terminal task with no report.
  const decisionContextReady = input.assignmentConnected && executionOutcomeKnown;
  const retryPreviewReady = input.serverAllowsRetry &&
    decisionContextReady && outputState === "verified";

  return {
    reason: ambiguousReason ?? (!decisionContextReady
      ? "evidence_missing"
      : "terminal_recorded"),
    assignmentConnected: input.assignmentConnected,
    executionOutcomeKnown,
    outputState,
    decisionContextReady,
    retryPreviewReady,
    missingEvidence,
  };
};
