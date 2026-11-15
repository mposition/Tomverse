/**
 * A v22 result that waits for review, put to the Decision Maker (owner
 * decision 2026-11-07: the Decision Maker replaces the operator for reversible
 * approvals). A result with no publication product -- an investigate run that
 * asked for an owner decision or gave no readable conclusion, a design or
 * verify result, an implement run that left no change -- used to wait for a
 * person in Admin. The relay now files it as a typed-ask card beside the human
 * escalation; the Decision Maker's answer approves it as done, runs it again
 * or blocks it for a person, and the app applies that answer.
 *
 * Pure: who is asked about, the card's words, and what an answer says.
 */

import { dmCardEvidenceContext } from "./decisionMakerWorkspaceCore.ts";

/**
 * Filing a review card starts a Decision Maker turn. Owner decision
 * 2026-11-15: the switches that make the Decision Maker work default on, and
 * are kill switches -- on unless exactly `disabled`.
 */
export const AMUX_V22_RESULT_REVIEW_DM_ENV = "TOMVERSE_AMUX_V22_RESULT_REVIEW_DM";
/** A Decision Maker proposal for a question the app answers itself is
 * applied without the operator's confirmation in Admin. On unless `disabled`. */
export const AMUX_DM_APPROVER_ENV = "TOMVERSE_AMUX_DM_APPROVER";

export type AmuxResultReviewEnv = Record<string, string | undefined>;
export const amuxV22ResultReviewDmEnabled = (env: AmuxResultReviewEnv = process.env) =>
  env[AMUX_V22_RESULT_REVIEW_DM_ENV]?.trim() !== "disabled";
export const amuxDmApproverEnabled = (env: AmuxResultReviewEnv = process.env) =>
  env[AMUX_DM_APPROVER_ENV]?.trim() !== "disabled";

export const AMUX_V22_RESULT_REVIEW_KINDS =
  ["needs_owner", "conclusion_invalid", "result_review", "prless_implement"] as const;
export type AmuxV22ResultReviewKind = (typeof AMUX_V22_RESULT_REVIEW_KINDS)[number];
export type AmuxV22ResultReviewDecision = "approve" | "retry" | "block";

/**
 * Why a settled result is put to review, or null when it is not one to file:
 * only a successful run with no patch, so the review never stands in for a
 * pull request's evidence.
 */
export function amuxV22ResultReviewKind(input: {
  executionRole: string | null;
  writesPatch: boolean;
  patchPresent: boolean;
  conclusionVerdict: string | null;
}): AmuxV22ResultReviewKind | null {
  if (input.patchPresent) return null;
  if (input.writesPatch) return "prless_implement";
  if (input.executionRole === "investigate") {
    if (input.conclusionVerdict === "needs_owner") return "needs_owner";
    if (input.conclusionVerdict === null) return "conclusion_invalid";
  }
  return "result_review";
}

/** One fixed sentence per kind. None may hit the routing term list on its own
 * (tests/amuxV22ResultReviewCore.test.mjs), so the card reaches a DM. */
export const AMUX_V22_RESULT_REVIEW_KIND_TEXT: Readonly<Record<AmuxV22ResultReviewKind, string>> =
  Object.freeze({
    needs_owner: "its investigation asked for a decision only the owner can make",
    conclusion_invalid: "its run ended without a readable conclusion",
    result_review: "its result has no pull request to review",
    prless_implement: "it was to change code but left no change",
  });

/** The session name the relay files a review card under: no worker session asks it. */
export const AMUX_V22_RESULT_REVIEW_DM_WORKER = "amux-result-review";
/** As the card close question: `claude` routes to `decision-maker-openai`. */
export const AMUX_V22_RESULT_REVIEW_DM_PROVIDER = "claude";

/**
 * The card the relay files, in the shape of a v22 question's pending entry,
 * or null when its evidence is missing. Written from the Task's number, its
 * role, the fixed sentence of its kind and its approved completion criteria;
 * the run's findings (its conclusion's, else the whole result) are in the
 * Decision Maker's workspace, whole (owner decision 2026-11-15), or in the
 * card's context, whole, with the workspace switched off. Nothing is cut and
 * nothing is left out to fit a card. Words in the criteria may send the card
 * to the operator: that is the routing working.
 */
export function amuxV22ResultReviewRelayCard(input: {
  reviewId: string;
  taskLabel: string;
  role: string | null;
  kind: AmuxV22ResultReviewKind;
  criteria: readonly string[];
  findings: string;
  /** Whether the Decision Maker has a workspace; the switch decides by default. */
  workspace?: boolean;
}) {
  if (input.criteria.length === 0 || !input.findings.trim()) return null;
  const context = dmCardEvidenceContext([{ name: "FINDINGS.md", heading: "Its run's report", text: input.findings }], input.workspace);
  if (context === null) return null;
  const question = [
    "A v22 Task finished and waits for review before it can be marked done.",
    `Task: ${input.taskLabel} (${input.role ?? "task"} Task)`,
    `Why it waits: ${AMUX_V22_RESULT_REVIEW_KIND_TEXT[input.kind]}.`,
    "Its completion criteria:",
    ...input.criteria.map((criterion) => `- ${criterion}`),
    "Its run's report is in the evidence named below.",
    "Should its result be approved as done, the Task run again, or the Task blocked for a person?",
  ].join("\n");
  return {
    question_id: input.reviewId,
    worker: AMUX_V22_RESULT_REVIEW_DM_WORKER,
    provider: AMUX_V22_RESULT_REVIEW_DM_PROVIDER,
    title: `Result review: ${input.taskLabel}`,
    question,
    context,
    unblocks: "An approved result finishes the Task so the Tasks after it can start; a retry runs it again; a block leaves it for a person.",
    options: [
      { id: "approve", label: "Approve the result; the Task is done" },
      { id: "retry", label: "Run the Task again" },
      { id: "block", label: "Block it for a person to look at" },
    ],
  };
}

const ANSWER_WORDS: Readonly<Record<string, AmuxV22ResultReviewDecision>> = Object.freeze({
  approve: "approve", retry: "retry", block: "block",
  "승인": "approve", "재시도": "retry", "차단": "block",
});

/**
 * What an answer says: the option a select chose, the DM's free text, or the
 * person's edited text, with the precedence the delivery candidate uses. Only
 * the fixed words count, whole; anything else is no answer and the review is
 * left to a person.
 */
export function amuxV22ResultReviewDecisionFromAnswer(input: {
  judgmentKind: string;
  outputKind: string | null;
  optionId: string | null;
  dmAnswer?: string;
  operatorAnswer?: string;
}): AmuxV22ResultReviewDecision | null {
  const text = input.judgmentKind === "edit_confirm" ? input.operatorAnswer :
    input.outputKind === "select" ? input.optionId : input.dmAnswer;
  if (typeof text !== "string") return null;
  const word = text.trim().toLowerCase();
  return Object.hasOwn(ANSWER_WORDS, word) ? ANSWER_WORDS[word] : null;
}

/** Where an applied decision sends a Task in review. */
export function amuxV22ResultReviewTarget(decision: AmuxV22ResultReviewDecision) {
  return decision === "approve" ? "done" as const :
    decision === "retry" ? "todo" as const : "blocked" as const;
}

/**
 * Whether a Decision Maker proposal may be applied without the operator:
 * a select or free-text proposal the DM did not mark irreversible. The DM's
 * own flag is the cheap check at this boundary; the answer words of each
 * question type are the other.
 */
export function amuxDmProposalAutoApplicable(detail: {
  resultKind: string; outputKind: string | null; irreversible: boolean | null;
} | null): boolean {
  return !!detail && detail.resultKind === "proposal" &&
    (detail.outputKind === "select" || detail.outputKind === "free_text") &&
    detail.irreversible === false;
}
