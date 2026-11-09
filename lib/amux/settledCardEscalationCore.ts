/**
 * A card that moved on while an earlier attempt's escalation stayed open
 * (AMUX-FILEREQ-004, 2026-11-09). An attempt stopped and opened a recovery
 * escalation; the owner's one-click recovery approval sent the card back to
 * todo before that approval resolved open escalations itself (#3480, live
 * 2026-11-09 10:05 AEST), and a later attempt may since have finished it.
 *
 * The review decision only opens on a card in review or blocked, so a done or
 * todo card was listed in the owner queue with nothing to press. The owner's
 * one action is to close the leftover escalation; the card, its status and
 * its history stay. A card in review or blocked keeps it: there the open
 * escalation is the row its review decision is made on.
 *
 * Pure: no database, no clock.
 */

export type AmuxSettledCardEscalationRefusal =
  | "decision_available" | "no_open_escalation" | "changed" | "running";

/** Where no review decision opens and nothing runs: done, or waiting to run again. */
const CLOSABLE_STATUSES: ReadonlySet<string> = new Set(["done", "todo"]);

/** Whether a card is shown the close: done or todo, with an escalation still open. */
export const isAmuxSettledCardWithOpenEscalation = (card: { status: string; escalationId: string | null }) =>
  CLOSABLE_STATUSES.has(card.status) && card.escalationId !== null;

/** Why the leftover escalations of a card cannot be closed now. Null when they can. */
export function amuxSettledCardEscalationRefusal(card: {
  status: string; activeDelivery: boolean; liveAttempt: boolean; openEscalationIds: readonly string[];
}, shownEscalationId: string): AmuxSettledCardEscalationRefusal | null {
  // A card being worked on, or one with queued work or an open attempt, is not left alone.
  if (card.status === "doing" || card.activeDelivery || card.liveAttempt) return "running";
  if (!CLOSABLE_STATUSES.has(card.status)) return "decision_available";
  if (card.openEscalationIds.length === 0) return "no_open_escalation";
  // The owner closes what was shown: a card whose open escalation is another
  // one than the shown is reloaded first.
  if (!card.openEscalationIds.includes(shownEscalationId)) return "changed";
  return null;
}
