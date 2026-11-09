import type { Prisma } from "@prisma/client";

import { AMUX_ESCALATION_AWAITING_STATUSES } from "./humanReviewCore.ts";

/**
 * The owner queue ("Waiting on me"): every card that waits on the owner, from
 * one definition, so the number on the sidebar entry, on the tab and in the
 * board's "Waiting on me" column is the same number.
 *
 * Pure and free of a database client. Nothing here decides an approval or a
 * retry: it names the cards and groups them. The decision itself stays in the
 * existing owner review (`useAmuxOwnerReview`) and its routes.
 */

/** The cards the list holds at most; a longer queue says it is partial. */
export const AMUX_OWNER_QUEUE_LIMIT = 100;

export const AMUX_OWNER_QUEUE_GROUPS = ["decide", "question", "recover", "read"] as const;
export type AmuxOwnerQueueGroup = (typeof AMUX_OWNER_QUEUE_GROUPS)[number];

/**
 * Which cards wait on the owner, whatever column they sit in, among the cards
 * that are not archived:
 *
 * - a blocked card (the board's attention lane),
 * - a card whose worker question is open, in any lane,
 * - a card with an open escalation.
 *
 * An archived card is left out even while an escalation on it is open: the
 * review decision and the Ubuntu inspection both refuse an archived card, so
 * the queue only showed cards nothing could be pressed on (owner decision
 * 2026-11-09). It is a set of cards, so a card in two of these is one card.
 */
export const amuxOwnerQueueWhere = (): Prisma.AmuxWorkItemWhereInput => ({
  OR: [
    { archivedAt: null, status: "blocked" },
    { archivedAt: null, humanEscalations: { some: { status: { in: [...AMUX_ESCALATION_AWAITING_STATUSES] } } } },
    { archivedAt: null, v22OwnerQuestions: { some: { state: "open" } } },
  ],
});

/** One card in the queue, as the read route returns it. */
export type AmuxOwnerQueueItem = {
  taskId: string;
  displayKey: string | null;
  sourceKey: string | null;
  /** Null when the title is protected or its retention ended. */
  title: string | null;
  status: string;
  worker: string | null;
  /** Channel of the worker, from the class it was registered with. */
  channel: "claude" | "codex" | "copilot" | "cursor" | null;
  /** Why a person is asked: the newest open escalation's reason code. */
  attentionReason: string | null;
  ownerQuestion: "open" | "answered" | null;
  /** The newest open escalation, which the owner review opens by id. */
  escalationId: string | null;
  /** When the card started waiting (ISO). */
  waitingSince: string;
};

export type AmuxOwnerQueueRead = {
  items: AmuxOwnerQueueItem[];
  /** Cards in the queue; larger than `items.length` when the list is partial. */
  total: number;
  /** Escalations a person resolved and questions a person answered since 00:00 AEST. Null: not read. */
  processedToday: number | null;
  /** Server time of the read; the list's "N hours ago" is counted from it. */
  generatedAt: string;
};

/** Reasons where the work itself stopped before it finished (a lost run, a limit, a failed tool). */
const RECOVER_REASONS: ReadonlySet<string> = new Set([
  "execution_blocked",
  "execution_lease_expired",
  "operational_cost_blocked",
  "cli_turn_limit",
  "cli_execution_error",
  "cli_budget_limit",
]);

/**
 * The group a card is listed under, from what the list read already holds
 * (the escalation's reason code and the question state).
 *
 * An open question is answered, whatever else the card says. A card whose work
 * stopped (a lost run, a limit) is to recover; one whose outcome is unknown, or
 * that has no open reason at all, is to read first. Every other reason, and any
 * reason this list does not know, asks the owner for a decision: a person was
 * asked, so the card is never filed as something to skip. The group never
 * promises that a decision is possible: only the protected review the screen
 * opens for the card does (`classifyAmuxOwnerQueueItem`), and it still shows
 * only the choices the server allows.
 */
export const amuxOwnerQueueGroup = (item: {
  attentionReason: string | null;
  ownerQuestion: "open" | "answered" | null;
}): AmuxOwnerQueueGroup => {
  if (item.ownerQuestion === "open") return "question";
  if (item.attentionReason === null || item.attentionReason === "usage_outcome_unknown") return "read";
  return RECOVER_REASONS.has(item.attentionReason) ? "recover" : "decide";
};

/** The count per group of the cards a list holds. */
export const amuxOwnerQueueGroupCounts = (
  items: ReadonlyArray<Pick<AmuxOwnerQueueItem, "attentionReason" | "ownerQuestion">>,
): Record<AmuxOwnerQueueGroup, number> => {
  const counts: Record<AmuxOwnerQueueGroup, number> = { decide: 0, question: 0, recover: 0, read: 0 };
  for (const item of items) counts[amuxOwnerQueueGroup(item)] += 1;
  return counts;
};

const AEST_OFFSET_MS = 10 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant the current day began in Brisbane (AEST, UTC+10, no daylight saving). */
export const amuxAestDayStartMs = (nowMs: number): number =>
  Math.floor((nowMs + AEST_OFFSET_MS) / DAY_MS) * DAY_MS - AEST_OFFSET_MS;

/**
 * The cards the list shows, in the order J and K walk them: the groups in their
 * fixed order, the read's own order (newest change first) inside each. A search
 * matches the card number, title, source key, Task ID and worker name.
 */
export const amuxOwnerQueueVisible = (
  items: readonly AmuxOwnerQueueItem[],
  filter: { group: AmuxOwnerQueueGroup | null; query: string },
): AmuxOwnerQueueItem[] => {
  const needle = filter.query.trim().toLowerCase();
  const matches = (item: AmuxOwnerQueueItem) => needle === "" || [
    item.displayKey, item.title, item.sourceKey, item.taskId, item.worker,
  ].some((value) => value !== null && value.toLowerCase().includes(needle));
  return AMUX_OWNER_QUEUE_GROUPS
    .filter((group) => filter.group === null || filter.group === group)
    .flatMap((group) => items.filter((item) => amuxOwnerQueueGroup(item) === group && matches(item)));
};
