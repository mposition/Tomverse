/**
 * The AMUX owner queue through the Decision Maker (owner decision 2026-11-13:
 * "1~4까지 DM에게 자동으로 하도록 승인합니다"). A v22 Task stopped in review or
 * blocked with an open human escalation, and held by no other Decision Maker
 * path, is put to the Decision Maker as a typed-ask card: the Task, why it
 * stopped, its approved completion criteria, what its run reported, the cards
 * beside it, and for a review pull request its files and diff. The answer
 * picks one way to settle it. Behind the DM approver switch the app applies a
 * reversible one -- run again, done, close, or remake as one new idea -- and an
 * approval of the pull request is only recorded, for the next stage.
 *
 * Pure: who is filed, the card's words, and what an answer says.
 */

import { createHash } from "node:crypto";

import { engineeringAgentPatchFiles } from "../engineeringAgentOwnerItemContextCore.ts";
import { patchSections } from "../engineeringAgentT2DmReviewCore.ts";

/** Default off. Filing a settlement card starts a Decision Maker turn. */
export const AMUX_DM_OWNER_SETTLEMENT_ENV = "TOMVERSE_AMUX_DM_OWNER_SETTLEMENT";
export const amuxDmOwnerSettlementEnabled = (env: Record<string, string | undefined> = process.env) =>
  env[AMUX_DM_OWNER_SETTLEMENT_ENV] === "enabled";

export const AMUX_DM_OWNER_SETTLEMENT_KINDS = ["t2_pr", "stopped"] as const;
export type AmuxDmOwnerSettlementKind = (typeof AMUX_DM_OWNER_SETTLEMENT_KINDS)[number];

/** The ways each kind may be settled. Only these words decide anything. */
export const AMUX_DM_OWNER_SETTLEMENT_DECISIONS = Object.freeze({
  stopped: ["retry", "complete", "close", "remake"],
  t2_pr: ["approve", "retry", "close"],
} as const);
export type AmuxDmOwnerSettlementDecision = "retry" | "complete" | "close" | "remake" | "approve";

/** What an answer decided: remake carries the new idea's text. */
export type AmuxDmOwnerSettlementAnswer =
  | { decision: Exclude<AmuxDmOwnerSettlementDecision, "remake"> }
  | { decision: "remake"; ideaText: string };

/** The session name the relay files a settlement card under: no worker session asks it. */
export const AMUX_DM_OWNER_SETTLEMENT_DM_WORKER = "amux-owner-settlement";
/** As the result review: `claude` routes to `decision-maker-openai`. */
export const AMUX_DM_OWNER_SETTLEMENT_DM_PROVIDER = "claude";
/** The relay's typed-ask question limit, as every other card's. */
export const AMUX_DM_OWNER_SETTLEMENT_QUESTION_MAX = 2_000;
const TITLE_MAX = 200;
const SIBLING_TITLE_MAX = 80;
/** Cards beside it listed by name; the rest are counted. */
export const AMUX_DM_OWNER_SETTLEMENT_SIBLINGS_SHOWN = 8;

/**
 * Which kind a stopped Task is filed as, or null when it is not filed: a
 * review pull request the engineering publisher opened as a draft is `t2_pr`;
 * a Task with no open pull request and no engineering item still in flight is
 * `stopped`. Any other open pull request is on its own approval path (the
 * merge observer completes it) and is not filed.
 */
export function amuxDmOwnerSettlementKind(input: {
  openBinding: "review_draft" | "other" | null;
  engineeringInFlight: boolean;
}): AmuxDmOwnerSettlementKind | null {
  if (input.engineeringInFlight) return null;
  if (input.openBinding === "review_draft") return "t2_pr";
  return input.openBinding === null ? "stopped" : null;
}

const uuidFromDigest = (digest: Buffer, version: 4 | 8) => {
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | (version << 4);
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * The settlement's id, derived from its escalation: a lowercase version 8
 * UUID, which the local AMUX takes as a question id. Every other question id
 * the relay files is a version 4 UUID, so a card write can tell a settlement's
 * apart without reading another table (docs/policy/amux-decision-maker.md §9's
 * twelve statements bound that write).
 */
export const amuxDmOwnerSettlementId = (escalationId: string) =>
  uuidFromDigest(createHash("sha256").update(`amux-dm-owner-settlement:${escalationId}`).digest(), 8);

const SETTLEMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isAmuxDmOwnerSettlementId = (id: string) => SETTLEMENT_ID.test(id);

/**
 * The idea request id of a remake, derived from the settlement and the exact
 * idea text (a version 4 UUID, as the idea intake takes): a lost answer reads
 * the same idea back instead of filing a second one.
 */
export const amuxDmOwnerSettlementRemakeRequestId = (settlementId: string, ideaText: string) =>
  uuidFromDigest(createHash("sha256").update(`amux-dm-owner-settlement-remake:${settlementId}\n`)
    .update(createHash("sha256").update(ideaText, "utf8").digest("hex")).digest(), 4);

/** One fixed sentence per escalation reason. None may hit the routing term
 * list on its own (tests/amuxDmOwnerSettlementCore.test.mjs), so the card
 * reaches a DM; the codes themselves are never written. */
export const AMUX_DM_OWNER_SETTLEMENT_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  human_review_required: "it waits for a person to review its result",
  execution_blocked: "its run was stopped and it waits for a person",
  attempt_budget_exhausted: "it has used every run it is allowed",
  execution_lease_expired: "its run stopped answering before it finished",
  usage_outcome_unknown: "how much its run used is not known",
  cli_turn_limit: "its run reached the command line tool's turn limit",
  cli_execution_error: "its run ended with a command line tool error",
  cli_budget_limit: "its run reached the command line tool's spending limit",
  analysis_stop: "its investigation concluded that the work should stop",
  analysis_replan: "its investigation concluded that the work needs a new plan",
  review_server_rejected_twice: "the review server rejected its change twice",
  operational_cost_blocked: "a cost limit holds it",
  canonical_deadline_review_required: "its deadline needs a person's review",
  local_card_closed: "its card on the worker host was closed",
  local_card_unlinked: "its card on the worker host lost its link",
  local_card_ambiguous: "its card on the worker host could not be told apart from another",
});
const OTHER_REASON = "it stopped and waits for a person";
export const amuxDmOwnerSettlementReasonText = (reason: string | null) =>
  (reason && AMUX_DM_OWNER_SETTLEMENT_REASON_TEXT[reason]) || OTHER_REASON;

export type AmuxDmOwnerSettlementSibling = {
  label: string; title: string | null; status: string; waitsOnThis: boolean;
};

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const shortTitle = (title: string) => {
  const line = oneLine(title);
  return line.length > SIBLING_TITLE_MAX ? `${line.slice(0, SIBLING_TITLE_MAX - 3)}...` : line;
};

function siblingLines(siblings: readonly AmuxDmOwnerSettlementSibling[], total: number) {
  if (total === 0) return ["No other cards share its parent."];
  const shown = siblings.slice(0, AMUX_DM_OWNER_SETTLEMENT_SIBLINGS_SHOWN);
  return [
    `Other cards under the same parent (${total}):`,
    ...shown.map((card) => `- ${card.label} (${card.status}${card.waitsOnThis ? ", waits on this card" : ""})` +
      (card.title ? `: ${shortTitle(card.title)}` : "")),
    ...(total > shown.length ? [`(${total - shown.length} more are not shown.)`] : []),
  ];
}

const REMAKE_LINE =
  "To replace it, and the cards that wait on it and have not started, with one new idea, answer in free text: the word remake on the first line, then the new idea.";

/**
 * The card the relay files, in the shape of a v22 question's pending entry,
 * or null when the evidence does not fit whole (the person decides it then).
 * The criteria and, for a stopped Task, the run's findings are never cut. A
 * review pull request's file list is always there; its file diffs follow whole
 * while the card has room, its findings only when they fit beside them, and
 * the card says what it left out. Words in the evidence may send the card to
 * the operator: that is the routing working.
 */
export function amuxDmOwnerSettlementCard(input: {
  settlementId: string;
  kind: AmuxDmOwnerSettlementKind;
  taskLabel: string;
  title: string | null;
  role: string | null;
  grade: string | null;
  taskStatus: string;
  reason: string | null;
  criteria: readonly string[];
  /** The run's findings (its conclusion's, else its whole result); null when it left none. */
  findings: string | null;
  /** How many times the review server rejected its change. */
  rejections: number;
  siblings: readonly AmuxDmOwnerSettlementSibling[];
  siblingTotal: number;
  /** A review pull request: its number and patch. */
  pull: { number: number; patch: string | null } | null;
}) {
  if (input.criteria.length === 0) return null;
  if (input.kind === "t2_pr" && !input.pull?.patch) return null;
  const findingsLine = input.findings !== null && input.findings.trim() ?
    `Its findings: ${input.findings}` : "Its run left no result to read.";
  const head = [
    input.kind === "t2_pr" ?
      "A v22 Task's pull request waits for the owner's approval. You decide what happens to it." :
      "A v22 Task stopped and waits for the owner. You decide what happens to it.",
    `Task: ${input.taskLabel}${input.title ? ` "${oneLine(input.title)}"` : ""} (${input.role ?? "task"} Task, grade ${input.grade ?? "unknown"}, now ${input.taskStatus})`,
    `Why it stopped: ${amuxDmOwnerSettlementReasonText(input.reason)}.`,
    "Its completion criteria:",
    ...input.criteria.map((criterion) => `- ${criterion}`),
  ];
  const rejected = input.rejections > 0 ? [
    `The review server rejected its change ${input.rejections === 1 ? "once" : `${input.rejections} times`}; ` +
      "the rejection findings are kept by the review server, not with the card."] : [];
  const siblings = siblingLines(input.siblings, input.siblingTotal);
  const max = AMUX_DM_OWNER_SETTLEMENT_QUESTION_MAX;
  if (input.kind === "stopped") {
    const question = [...head, findingsLine, ...rejected, ...siblings, REMAKE_LINE,
      "Should the Task run again, be marked done because its work is in, or be closed?"].join("\n");
    if (question.length > max) return null;
    return {
      question_id: input.settlementId,
      worker: AMUX_DM_OWNER_SETTLEMENT_DM_WORKER,
      provider: AMUX_DM_OWNER_SETTLEMENT_DM_PROVIDER,
      title: `Owner queue: ${input.taskLabel}`.slice(0, TITLE_MAX),
      question,
      unblocks: "A retry runs the Task again; done lets the Tasks after it start; a close takes the card off the board; a remake files one new idea in place of the cards it closes.",
      options: [
        { id: "retry", label: "Run the Task again" },
        { id: "complete", label: "Mark the Task done; its work is in" },
        { id: "close", label: "Close the card without finishing it" },
      ],
    };
  }
  const patch = input.pull!.patch!;
  const files = engineeringAgentPatchFiles(patch);
  if (files.length === 0) return null;
  const pullHead = [`Pull request #${input.pull!.number}, files (${files.length}):`,
    ...files.map((file) => `- ${file.path} (+${file.added} -${file.removed})`)];
  const tail = ["Should the pull request be approved, the Task run again, or the card closed?"];
  const fixed = [...head, ...rejected, ...siblings, ...pullHead, ...tail].join("\n");
  if (fixed.length > max) return null;
  // Room for the findings first, whole, then for the diffs, each whole.
  const findingsFit = fixed.length + 1 + findingsLine.length + 80 <= max;
  const shownFindings = findingsFit ? findingsLine : "Its run's report does not fit this card; judge it from the patch.";
  let left = max - fixed.length - shownFindings.length - 1 - 80;
  const shown: string[] = [];
  const sections = patchSections(patch);
  for (const section of sections) {
    if (section.length + 1 > left) break;
    shown.push(section);
    left -= section.length + 1;
  }
  const omitted = sections.length - shown.length;
  const question = [...head, shownFindings, ...rejected, ...siblings, ...pullHead,
    shown.length > 0 ? "Patch:" : "The patch does not fit this card; judge it from the file list.",
    ...shown,
    ...(shown.length > 0 && omitted > 0 ? [`(${omitted} more file diffs are not shown.)`] : []),
    ...tail].join("\n");
  if (question.length > max) return null;
  return {
    question_id: input.settlementId,
    worker: AMUX_DM_OWNER_SETTLEMENT_DM_WORKER,
    provider: AMUX_DM_OWNER_SETTLEMENT_DM_PROVIDER,
    title: `Owner queue: ${input.taskLabel}`.slice(0, TITLE_MAX),
    question,
    unblocks: "An approval is kept for the merge lane, which acts on it later; a retry runs the Task again; a close takes the card off the board and leaves the pull request.",
    options: [
      { id: "approve", label: "Approve the pull request" },
      { id: "retry", label: "Run the Task again" },
      { id: "close", label: "Close the card and leave the pull request" },
    ],
  };
}

const ANSWER_WORDS: Readonly<Record<string, Exclude<AmuxDmOwnerSettlementDecision, "remake">>> =
  Object.freeze({
    retry: "retry", complete: "complete", close: "close", approve: "approve",
    "재시도": "retry", "완료": "complete", "닫기": "close", "승인": "approve",
  });
const REMAKE = /^\s*remake[ \t]*(?::|\r?\n)\s*([\s\S]*\S)\s*$/i;

/**
 * What an answer says: the option a select chose, the DM's free text, or the
 * person's edited text, with the precedence the delivery candidate uses. Only
 * the kind's fixed words count, whole; a remake is the word remake and then
 * the new idea. Anything else is no answer, and the person decides.
 */
export function amuxDmOwnerSettlementAnswerOf(input: {
  kind: AmuxDmOwnerSettlementKind;
  judgmentKind: string;
  outputKind: string | null;
  optionId: string | null;
  dmAnswer?: string;
  operatorAnswer?: string;
}): AmuxDmOwnerSettlementAnswer | null {
  const text = input.judgmentKind === "edit_confirm" ? input.operatorAnswer :
    input.outputKind === "select" ? input.optionId : input.dmAnswer;
  if (typeof text !== "string") return null;
  const allowed: readonly string[] = AMUX_DM_OWNER_SETTLEMENT_DECISIONS[input.kind];
  const remake = REMAKE.exec(text);
  if (remake) return allowed.includes("remake") ? { decision: "remake", ideaText: remake[1]!.trim() } : null;
  const word = text.trim().toLowerCase();
  const decision = Object.hasOwn(ANSWER_WORDS, word) ? ANSWER_WORDS[word]! : null;
  return decision && allowed.includes(decision) ? { decision } : null;
}
