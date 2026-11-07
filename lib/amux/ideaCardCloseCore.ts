/**
 * The cards an idea left behind (owner decision 2026-11-05). An idea in its
 * execution stage can stop with cards nobody will run, and nothing closed them.
 * This decides, from facts the service reads, whether an idea is one to ask
 * about and what would be closed; the question itself goes to the Decision
 * Maker and a person, who judge it. It never judges whether the idea is worth
 * finishing.
 *
 * Pure: the service (ideaCardCloseService.ts) reads the rows, this decides.
 */

import { AMUX_IDEA_BLOCK_REASONS, amuxIdeaBlockReason, type AmuxIdeaBlockReason } from "./ideaProgressCore.ts";

/** Default off. A question filed to the Decision Maker is a paid turn. */
export const AMUX_IDEA_CARD_CLOSE_ENV = "TOMVERSE_AMUX_CARD_CLOSE_DM";
export const AMUX_IDEA_CARD_CLOSE_DAILY_ENV = "AMUX_IDEA_CARD_CLOSE_MAX_PER_DAY";
export const AMUX_IDEA_CARD_CLOSE_STALE_DAYS_ENV = "AMUX_IDEA_CARD_CLOSE_STALE_DAYS";
export const AMUX_IDEA_CARD_CLOSE_DEFAULT_DAILY = 5;
export const AMUX_IDEA_CARD_CLOSE_DEFAULT_STALE_DAYS = 7;
/** An idea the owner kept is not asked about again for this long. */
export const AMUX_IDEA_CARD_CLOSE_KEEP_DAYS = 30;
/** A question that closed with no effect is not asked again for this long. */
export const AMUX_IDEA_CARD_CLOSE_CANCEL_COOLDOWN_DAYS = 1;
/** At most this many questions or cards per relay tick, as the v22 list. */
export const AMUX_IDEA_CARD_CLOSE_SYNC_LIMIT = 3;
/** Ideas read per scan. The scan's filter makes the core's exclusions before this bound. */
export const AMUX_IDEA_CARD_CLOSE_SCAN = 24;

export type AmuxIdeaCardCloseEnv = Record<string, string | undefined>;

export const amuxIdeaCardCloseEnabled = (env: AmuxIdeaCardCloseEnv = process.env) =>
  env[AMUX_IDEA_CARD_CLOSE_ENV] === "enabled";

const boundedInteger = (raw: string | undefined, min: number, max: number, fallback: number) => {
  const value = Number(raw ?? "");
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
};

export const amuxIdeaCardCloseDailyLimit = (env: AmuxIdeaCardCloseEnv = process.env) =>
  boundedInteger(env[AMUX_IDEA_CARD_CLOSE_DAILY_ENV], 1, 50, AMUX_IDEA_CARD_CLOSE_DEFAULT_DAILY);

export const amuxIdeaCardCloseStaleDays = (env: AmuxIdeaCardCloseEnv = process.env) =>
  boundedInteger(env[AMUX_IDEA_CARD_CLOSE_STALE_DAYS_ENV], 1, 365, AMUX_IDEA_CARD_CLOSE_DEFAULT_STALE_DAYS);

export type AmuxIdeaCardCloseReason = "blocked_task" | "stale_cards";
export type AmuxIdeaCardCloseDecision = "close" | "keep";
export type AmuxIdeaCardCloseAnswerSource = "operator" | "dm_confirmed" | "dm";

/** One registered card of an idea, with what could still be moving it. */
export type AmuxIdeaCardCloseCardFact = {
  id: string;
  displayKey: string | null;
  cardType: string | null;
  status: string;
  /** Has a worker or an assignment, whatever its status. */
  assigned: boolean;
  updatedAtMs: number;
  /** An execution attempt has not ended. */
  liveAttempt: boolean;
  /** A v22 worker's own question waits for its answer or its resume. */
  workerQuestion: boolean;
  /** A card of another idea, still unfinished, depends on this one. */
  foreignDependent: boolean;
  /** The open escalation's reason and the last attempt's, as the progress read takes them. */
  escalationReason?: string | null;
  lastAttemptReason?: string | null;
};

/**
 * What a question records about a card, and all it says about it. The last two
 * came later (2026-11-06): a row written before has neither, and its question
 * reads as it did. Neither takes part in comparing the cards when answering.
 */
export type AmuxIdeaCardCloseAskedCard = {
  id: string; displayKey: string | null; cardType: string | null; status: string;
  /** Why a blocked card is blocked, as the idea's detail shows it; null when not known. */
  blockReason?: AmuxIdeaBlockReason | null;
  /** When the card last changed, as of the question. */
  updatedAtMs?: number;
};

/**
 * A short, neutral sentence per block reason for the question. The codes
 * themselves are not written: one could hit the routing term list and send the
 * question to the operator (tests/amuxIdeaCardCloseCore.test.mjs checks each).
 */
export const AMUX_IDEA_CARD_CLOSE_BLOCK_REASON_TEXT: Readonly<Record<AmuxIdeaBlockReason, string>> = Object.freeze({
  human_review_required: "a person was asked to review it",
  execution_blocked: "its run was stopped",
  attempt_budget_exhausted: "it used up its allowed runs",
  attempts: "its runs kept failing",
  execution_lease_expired: "its run stopped reporting",
  usage_outcome_unknown: "the run's result and cost are unknown",
  outcome_unknown: "the run's result is unknown",
  operational_cost_blocked: "a run would go over its cost limit",
  cost_reconfirmation_required: "its cost estimate needs a new confirmation",
  canonical_deadline_review_required: "a person must review its deadline",
  local_card_closed: "its card on the local board was closed",
  local_card_unlinked: "its card on the local board is no longer linked",
  local_card_ambiguous: "more than one local board card matches it",
  assignment_mismatch: "its worker assignment did not match",
  contract_path_touched: "it changed files that need a person's review",
  incident_frozen: "work was frozen during an incident",
  orchestrator_halted: "the work scheduler was halted",
  cli_turn_limit: "its run stopped at its turn limit",
  cli_execution_error: "its run stopped with an execution error",
  cli_budget_limit: "its run stopped at its cost limit",
  analysis_stop: "its investigation concluded the idea should not go on",
  analysis_replan: "its investigation concluded the remaining plan should change",
  review_server_rejected_twice: "the automatic code review rejected its change twice",
});

const FINISHED = new Set(["done", "cancelled"]);
const CLOSABLE = new Set(["backlog", "blocked", "todo"]);
const MOVING = new Set(["doing", "review"]);

export type AmuxIdeaCardCloseTargets =
  | { ok: true; targets: AmuxIdeaCardCloseCardFact[] }
  | { ok: false; why: "no_task" | "all_finished" | "work_started" | "worker_question" |
      "foreign_dependent" | "unknown_status" };

/**
 * What would be closed, or why nothing may be: an idea with a Task, not all
 * finished, with nothing running, in review, assigned or asking. Stories count
 * for what is closed, never for whether there is a Task left.
 */
export function amuxIdeaCardCloseTargets(cards: readonly AmuxIdeaCardCloseCardFact[]): AmuxIdeaCardCloseTargets {
  const tasks = cards.filter((card) => card.cardType === "task");
  if (tasks.length === 0) return { ok: false, why: "no_task" };
  if (tasks.every((card) => FINISHED.has(card.status))) return { ok: false, why: "all_finished" };
  if (cards.some((card) => !FINISHED.has(card.status) && !CLOSABLE.has(card.status) && !MOVING.has(card.status))) {
    return { ok: false, why: "unknown_status" };
  }
  if (cards.some((card) => MOVING.has(card.status) || card.liveAttempt ||
      (!FINISHED.has(card.status) && card.assigned))) {
    return { ok: false, why: "work_started" };
  }
  if (cards.some((card) => card.workerQuestion)) return { ok: false, why: "worker_question" };
  const targets = cards.filter((card) => CLOSABLE.has(card.status));
  if (targets.some((card) => card.foreignDependent)) return { ok: false, why: "foreign_dependent" };
  return { ok: true, targets };
}

/** Why an idea is one to ask about: a blocked Task, or remaining cards unchanged for the period. */
export function amuxIdeaCardCloseCandidate(cards: readonly AmuxIdeaCardCloseCardFact[],
  input: { nowMs: number; staleDays: number }):
  { reason: AmuxIdeaCardCloseReason; targets: AmuxIdeaCardCloseCardFact[] } | null {
  const verdict = amuxIdeaCardCloseTargets(cards);
  if (!verdict.ok) return null;
  const { targets } = verdict;
  if (targets.some((card) => card.cardType === "task" && card.status === "blocked")) {
    return { reason: "blocked_task", targets };
  }
  const cutoff = input.nowMs - input.staleDays * 86_400_000;
  return targets.every((card) => card.updatedAtMs < cutoff) ? { reason: "stale_cards", targets } : null;
}

/** Why a question cannot close what it asked about now; null when it still can. */
export function amuxIdeaCardCloseRefusal(input: {
  ideaCancelled: boolean;
  asked: readonly AmuxIdeaCardCloseAskedCard[];
  cards: readonly AmuxIdeaCardCloseCardFact[];
}): "idea_cancelled" | "work_started" | "cards_changed" | null {
  if (input.ideaCancelled) return "idea_cancelled";
  const verdict = amuxIdeaCardCloseTargets(input.cards);
  if (!verdict.ok) return verdict.why === "work_started" || verdict.why === "worker_question" ?
    "work_started" : "cards_changed";
  const asked = new Set(input.asked.map((card) => card.id));
  return verdict.targets.length === asked.size && verdict.targets.every((card) => asked.has(card.id))
    ? null : "cards_changed";
}

/** The cards a question's row holds, or null when they are not what it writes. */
export function amuxIdeaCardCloseAskedCards(value: unknown): AmuxIdeaCardCloseAskedCard[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const cards: AmuxIdeaCardCloseAskedCard[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { id, displayKey, cardType, status, blockReason, updatedAtMs } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof status !== "string" ||
        (displayKey !== null && typeof displayKey !== "string") ||
        (cardType !== null && typeof cardType !== "string")) return null;
    const asked: AmuxIdeaCardCloseAskedCard = { id, displayKey, cardType, status };
    // Context only: an unreadable value is left out, never a reason to refuse the row.
    if (blockReason === null || (AMUX_IDEA_BLOCK_REASONS as readonly unknown[]).includes(blockReason)) {
      asked.blockReason = blockReason as AmuxIdeaBlockReason | null;
    }
    if (typeof updatedAtMs === "number" && Number.isFinite(updatedAtMs)) asked.updatedAtMs = updatedAtMs;
    cards.push(asked);
  }
  return cards;
}

export const amuxIdeaCardCloseAskedFrom = (targets: readonly AmuxIdeaCardCloseCardFact[]):
  AmuxIdeaCardCloseAskedCard[] => targets.map((card) => ({
  id: card.id, displayKey: card.displayKey, cardType: card.cardType, status: card.status,
  ...(card.status === "blocked" ?
    { blockReason: amuxIdeaBlockReason(card.escalationReason, card.lastAttemptReason) } : {}),
  updatedAtMs: card.updatedAtMs,
}));

/**
 * The session name the relay files a question's local card under. No worker
 * asked it, so it names no session on the AMUX host, and the provider below
 * comes from the card's own tag. Within the app's `is_ledger_identifier` and
 * the local AMUX's 128 bytes.
 */
export const AMUX_IDEA_CARD_CLOSE_DM_WORKER = "amux-card-close";
/**
 * The provider class the Decision Maker routes by
 * (docs/policy/amux-decision-maker.md §7): `claude` goes to
 * `decision-maker-openai`. No worker asked, so this only picks the instance.
 */
export const AMUX_IDEA_CARD_CLOSE_DM_PROVIDER = "claude";

/** The local AMUX's bounds on a filed card (vendor/amux dm_relay_v22.rs). */
export const AMUX_IDEA_CARD_CLOSE_QUESTION_MAX = 2_000;
export const AMUX_IDEA_CARD_CLOSE_TITLE_MAX = 200;

const cardLabel = (card: AmuxIdeaCardCloseAskedCard) => card.displayKey ?? card.id;

const DAY_MS = 86_400_000;
const wholeDays = (updatedAtMs: number, nowMs: number) => Math.floor(Math.max(0, nowMs - updatedAtMs) / DAY_MS);
const dayCount = (days: number) => `${days} ${days === 1 ? "day" : "days"}`;
const unchangedFor = (updatedAtMs: number, nowMs: number) => {
  const days = wholeDays(updatedAtMs, nowMs);
  return days === 0 ? "changed within the last day" : `unchanged for ${dayCount(days)}`;
};

/** One card's line: its number, kind and status, why it is blocked and how long it has not changed. */
function cardLine(card: AmuxIdeaCardCloseAskedCard, nowMs: number | undefined) {
  const status = card.status === "blocked" && card.blockReason !== undefined
    ? `blocked: ${card.blockReason ? AMUX_IDEA_CARD_CLOSE_BLOCK_REASON_TEXT[card.blockReason] : "reason not recorded"}`
    : card.status;
  const age = nowMs !== undefined && card.updatedAtMs !== undefined ? `; ${unchangedFor(card.updatedAtMs, nowMs)}` : "";
  return `${cardLabel(card)} (${card.cardType ?? "card"}, ${status}${age})`;
}

/**
 * The card the relay files, in the shape of a v22 question's pending entry.
 * Written here from card numbers, statuses, each blocked card's reason as a
 * fixed sentence, how long the cards have not changed and the reason code
 * only: never the idea's text. No word of it may hit the routing term list on
 * its own (tests/amuxIdeaCardCloseCore.test.mjs), so a question reaches a DM
 * unless a card's own number says otherwise, and then it stays with the
 * operator. A row written before the reasons and dates reads without them.
 */
export function amuxIdeaCardCloseRelayCard(input: {
  questionId: string; reasonCode: string; cards: readonly AmuxIdeaCardCloseAskedCard[]; nowMs?: number;
}) {
  const { nowMs } = input;
  const dated = input.cards.flatMap((card) => card.updatedAtMs === undefined ? [] : [card.updatedAtMs]);
  // The idea as a whole: how long since any of its remaining cards changed.
  const quiet = nowMs !== undefined && dated.length === input.cards.length ?
    wholeDays(Math.max(...dated), nowMs) : null;
  const head = [
    `An AMUX idea has stopped moving (reason code: ${input.reasonCode}). ` +
      "None of its cards is running, in review or assigned to a worker.",
    ...(quiet === null ? [] : [quiet === 0 ? "One of its remaining cards changed within the last day." :
      `None of its remaining cards has changed for ${dayCount(quiet)}.`]),
    "Remaining cards:",
  ];
  const tail = "Should the remaining cards be closed?";
  const lines: string[] = [];
  // The whole list when it fits; the local AMUX refuses a longer question.
  const room = AMUX_IDEA_CARD_CLOSE_QUESTION_MAX - head.join("\n").length - tail.length - 40;
  let used = 0;
  for (const card of input.cards) {
    const line = cardLine(card, nowMs);
    if (used + line.length + 1 > room) break;
    lines.push(line);
    used += line.length + 1;
  }
  const more = input.cards.length - lines.length;
  return {
    question_id: input.questionId,
    worker: AMUX_IDEA_CARD_CLOSE_DM_WORKER,
    provider: AMUX_IDEA_CARD_CLOSE_DM_PROVIDER,
    title: `Idea cards stalled: ${cardLabel(input.cards[0])}`.slice(0, AMUX_IDEA_CARD_CLOSE_TITLE_MAX),
    question: [...head, ...lines, ...(more > 0 ? [`and ${more} more`] : []), tail].join("\n"),
    unblocks: `The remaining cards are closed as cancelled, or kept and not asked about for ${AMUX_IDEA_CARD_CLOSE_KEEP_DAYS} days.`,
    options: [
      { id: "close", label: "Close the remaining cards as cancelled" },
      { id: "keep", label: `Keep them and do not ask for ${AMUX_IDEA_CARD_CLOSE_KEEP_DAYS} days` },
    ],
  };
}

const ANSWER_WORDS: Readonly<Record<string, AmuxIdeaCardCloseDecision>> = Object.freeze({
  close: "close", keep: "keep", "닫기": "close", "유지": "keep",
});

/**
 * What a confirmed answer says: the option a confirmed select chose, the DM's
 * free text, or the person's edited text, the same precedence the delivery
 * candidate uses. Only the fixed words count, whole. Anything else is no answer:
 * an irreversible step is never taken on a guess, so it goes to a person.
 */
export function amuxIdeaCardCloseDecisionFromAnswer(input: {
  judgmentKind: string;
  outputKind: string | null;
  optionId: string | null;
  dmAnswer?: string;
  operatorAnswer?: string;
}): AmuxIdeaCardCloseDecision | null {
  const text = input.judgmentKind === "edit_confirm" ? input.operatorAnswer :
    input.outputKind === "select" ? input.optionId : input.dmAnswer;
  if (typeof text !== "string") return null;
  const word = text.trim().toLowerCase();
  return Object.hasOwn(ANSWER_WORDS, word) ? ANSWER_WORDS[word] : null;
}

/** The owner's reason, as an idea close bounds it; it goes to the audit as a digest. */
export const amuxIdeaCardCloseReasonValid = (reason: unknown): reason is string =>
  typeof reason === "string" && reason === reason.trim() && reason.length >= 3 && reason.length <= 500;
