import { amuxCardStatusGroup, amuxElapsed, type AmuxCardStatusGroup } from "./adminAmuxFlow.ts";
import { formatAestDateTime, type AdminTone } from "./adminUiCore.ts";

/**
 * Presentation arithmetic for the Execution board redesign (step 9): the four
 * reasons the "waiting on you" column groups its cards by, the status a card's
 * stored state is drawn as, and the "past work" filter groups.
 *
 * Pure and free of React. Nothing here decides an approval or a halt: it maps
 * rows the server already read onto the words and colours the screen draws.
 */

/** The four things a card waiting on the owner can be asking for. */
export const AMUX_ATTENTION_GROUPS = ["decision", "question", "recovery", "read"] as const;
export type AmuxAttentionGroup = (typeof AMUX_ATTENTION_GROUPS)[number];

/** The work itself stopped; there is nothing to decide until it is recovered. */
const RECOVERY_REASONS: ReadonlySet<string> = new Set([
  "execution_blocked",
  "execution_lease_expired",
  "cli_execution_error",
]);

/** The result is not known; the owner has to read what happened first. */
const READ_REASONS: ReadonlySet<string> = new Set(["usage_outcome_unknown"]);

/**
 * The group a board card waiting on the owner counts in.
 *
 * It follows `classifyAmuxOwnerQueueItem` (decision, technical recovery, needs
 * a read) with the worker question the queue does not carry as a fourth group.
 * The queue classifier needs the protected review of one escalation, which the
 * board does not load, so this is the same split drawn from what the board
 * does have: the open question and the newest open escalation's reason code.
 * A card with neither (blocked with no open escalation) is one to read first.
 */
export function amuxAttentionGroup(card: {
  attentionReason: string | null;
  ownerQuestion: "open" | "answered" | null;
}): AmuxAttentionGroup {
  if (card.ownerQuestion === "open") return "question";
  const reason = card.attentionReason;
  if (reason === null) return "read";
  if (RECOVERY_REASONS.has(reason)) return "recovery";
  if (READ_REASONS.has(reason)) return "read";
  return "decision";
}

/**
 * Cards per group. A Decision Maker request is a proposal the owner judges, so
 * it counts as a decision.
 */
export function amuxAttentionCounts(
  cards: ReadonlyArray<{ attentionReason: string | null; ownerQuestion: "open" | "answered" | null }>,
  decisionMakerTotal = 0
): Record<AmuxAttentionGroup, number> {
  const counts: Record<AmuxAttentionGroup, number> = { decision: decisionMakerTotal, question: 0, recovery: 0, read: 0 };
  for (const card of cards) counts[amuxAttentionGroup(card)] += 1;
  return counts;
}

/** The colour a stored card status is drawn in, as the console's five tones. */
export const AMUX_STATUS_TONE: Record<AmuxCardStatusGroup, AdminTone> = {
  waiting: "idle",
  running: "info",
  review: "info",
  done: "ok",
  blocked: "bad",
  cancelled: "idle",
  other: "unknown",
};

/** The status chip of a stored card status: its group and tone. */
export function amuxStatusChip(status: string): { group: AmuxCardStatusGroup; tone: AdminTone } {
  const group = amuxCardStatusGroup(status);
  return { group, tone: AMUX_STATUS_TONE[group] };
}

/** The filter groups of the past-work list. A card in the archive drawer is "archived" whatever its status. */
export const AMUX_PAST_WORK_KINDS = ["done", "blocked", "cancelled", "archived"] as const;
export type AmuxPastWorkKind = (typeof AMUX_PAST_WORK_KINDS)[number] | "other";

export function amuxPastWorkKind(card: { status: string; archived: boolean }): AmuxPastWorkKind {
  if (card.archived) return "archived";
  const group = amuxCardStatusGroup(card.status);
  return group === "done" || group === "blocked" || group === "cancelled" ? group : "other";
}

/** The filter groups of the card list: one per card status group the list names. */
export const AMUX_LIST_STATUS_GROUPS = ["waiting", "running", "review", "blocked", "done", "cancelled"] as const;

/** Whether `needle` appears in any of the values, ignoring case. An empty needle matches. */
export function amuxMatchesSearch(needle: string, values: ReadonlyArray<string | null | undefined>): boolean {
  const query = needle.trim().toLocaleLowerCase();
  return query === "" || values.some((value) => value?.toLocaleLowerCase().includes(query));
}

/** "11-07 14:20" in Brisbane time (AEST); null for a time that cannot be read. */
export function amuxAestShort(value: string | null | undefined): string | null {
  const full = formatAestDateTime(value);
  // "2026-11-07 14:20 AEST" -> "11-07 14:20"
  return full === null ? null : full.slice(5, 16);
}

/** "1 hour ago" in the console language; null for a time that cannot be read. */
export function amuxAgoText(iso: string, nowMs: number | null, locale: string): string | null {
  if (nowMs === null) return null;
  const elapsed = amuxElapsed(Date.parse(iso), nowMs);
  if (elapsed === null) return null;
  if (elapsed.unit === "minute" && elapsed.value < 1) return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "minute");
  return new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "short" }).format(-elapsed.value, elapsed.unit);
}

/** A duration in the largest whole unit that is not zero: seconds, minutes, then hours. Null for a value that is not a duration. */
export function amuxDurationParts(ms: number | null): { value: number; unit: "second" | "minute" | "hour" } | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return { value: seconds, unit: "second" };
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? { value: minutes, unit: "minute" } : { value: Math.round(minutes / 60), unit: "hour" };
}
