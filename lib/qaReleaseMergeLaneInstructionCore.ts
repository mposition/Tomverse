/**
 * The app's side of a QA-release merge lane instruction: when it may issue
 * one, and when a consume request may succeed.
 *
 * docs/policy/qa-release-agent.md (version 3), section 3 (the instruction
 * steps) and section 8 item 6 (each switch is judged by the side that can
 * read it). The app judges only what it can read itself -- the newest
 * operator control revision, the develop lane switch in that revision, the
 * lane latch, the instruction row and the database clock -- and never a
 * service's own variables, which would be a self-report.
 *
 * Pure. The single successful consume is the database's job (a conditional
 * update); this module only decides whether the request may try.
 */

/** An instruction lives two minutes from issue (policy section 3). */
export const QA_RELEASE_INSTRUCTION_TTL_MS = 2 * 60 * 1000;

const SHA = /^[0-9a-f]{40}$/;

/** The newest operator control revision as the app reads it; null when there is none or it is unread. */
export type QaReleaseLaneControl = { revision: number; developLaneOn: boolean } | null;

export type QaReleaseIssueInput = {
  control: QaReleaseLaneControl;
  /** The revision number the calling service presents. */
  callerRevision: number | null;
  latched: boolean | null;
  attemptOpen: boolean | null;
  pullRequest: { number: number; headSha: string; base: string };
};

export type QaReleaseIssueRefusal =
  | "control_unavailable"
  | "revision_mismatch"
  | "develop_lane_off"
  | "lane_state_unknown"
  | "latched"
  | "attempt_open"
  | "not_develop"
  | "invalid_pull_request";

export function judgeQaReleaseInstructionIssue(
  input: QaReleaseIssueInput,
): { issue: true; revision: number } | { issue: false; reason: QaReleaseIssueRefusal } {
  if (input.control === null) return { issue: false, reason: "control_unavailable" };
  if (input.callerRevision !== input.control.revision) return { issue: false, reason: "revision_mismatch" };
  if (!input.control.developLaneOn) return { issue: false, reason: "develop_lane_off" };
  if (input.latched === null || input.attemptOpen === null) return { issue: false, reason: "lane_state_unknown" };
  if (input.latched) return { issue: false, reason: "latched" };
  if (input.attemptOpen) return { issue: false, reason: "attempt_open" };
  const { number, headSha, base } = input.pullRequest;
  if (!Number.isSafeInteger(number) || number <= 0 || !SHA.test(headSha)) {
    return { issue: false, reason: "invalid_pull_request" };
  }
  if (base !== "develop") return { issue: false, reason: "not_develop" };
  return { issue: true, revision: input.control.revision };
}

/** The stored instruction, as the consume transaction reads it under lock. */
export type QaReleaseStoredInstruction = {
  attemptId: string;
  pullRequestNumber: number;
  headSha: string;
  base: string;
  revision: number;
  expiresAtMs: number;
  consumed: boolean;
};

export type QaReleaseConsumeInput = {
  instruction: QaReleaseStoredInstruction | null;
  /** What the service re-read from GitHub and sends back. */
  request: { attemptId: string; pullRequestNumber: number; headSha: string; base: string };
  control: QaReleaseLaneControl;
  callerRevision: number | null;
  latched: boolean | null;
  /** The database clock at the consume. */
  dbNowMs: number;
};

export type QaReleaseConsumeRefusal =
  | "instruction_unknown"
  | "already_consumed"
  | "expired"
  | "binding_mismatch"
  | "not_develop"
  | "control_unavailable"
  | "revision_mismatch"
  | "revision_moved"
  | "develop_lane_off"
  | "lane_state_unknown"
  | "latched";

/**
 * Whether a consume may succeed. A revision recorded after the instruction
 * was issued refuses it even when the switch is still on: the instruction is
 * bound to the revision it was issued under (policy section 3, step 2).
 */
export function judgeQaReleaseInstructionConsume(
  input: QaReleaseConsumeInput,
): { consume: true } | { consume: false; reason: QaReleaseConsumeRefusal } {
  const { instruction, request } = input;
  if (instruction === null || instruction.attemptId !== request.attemptId) {
    return { consume: false, reason: "instruction_unknown" };
  }
  if (instruction.consumed) return { consume: false, reason: "already_consumed" };
  if (!Number.isFinite(input.dbNowMs) || !Number.isFinite(instruction.expiresAtMs) || input.dbNowMs >= instruction.expiresAtMs) {
    return { consume: false, reason: "expired" };
  }
  if (
    request.pullRequestNumber !== instruction.pullRequestNumber ||
    request.headSha !== instruction.headSha ||
    request.base !== instruction.base
  ) {
    return { consume: false, reason: "binding_mismatch" };
  }
  if (instruction.base !== "develop") return { consume: false, reason: "not_develop" };
  if (input.control === null) return { consume: false, reason: "control_unavailable" };
  if (input.callerRevision !== input.control.revision) return { consume: false, reason: "revision_mismatch" };
  if (instruction.revision !== input.control.revision) return { consume: false, reason: "revision_moved" };
  if (!input.control.developLaneOn) return { consume: false, reason: "develop_lane_off" };
  if (input.latched === null) return { consume: false, reason: "lane_state_unknown" };
  if (input.latched) return { consume: false, reason: "latched" };
  return { consume: true };
}
