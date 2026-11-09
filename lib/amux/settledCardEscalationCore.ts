/**
 * A done card that still holds an open escalation (AMUX-FILEREQ-004,
 * 2026-11-09). An earlier attempt stopped and opened a recovery escalation; a
 * later attempt then finished the Task, before settlement resolved such
 * escalations itself (resolveSupersededAmuxRecoveryEscalations). The review
 * decision only opens on a card in review or blocked, so the owner queue
 * listed the card with nothing to press. The owner's one action is to close
 * the leftover escalation; the card, its status and its history stay.
 *
 * Pure: no database, no clock.
 */

export type AmuxSettledCardEscalationRefusal =
  | "not_done" | "no_open_escalation" | "changed" | "running";

/** Whether a card is shown the close: done, with an escalation still open. */
export const isAmuxSettledCardWithOpenEscalation = (card: { status: string; escalationId: string | null }) =>
  card.status === "done" && card.escalationId !== null;

/** Why the leftover escalations of a card cannot be closed now. Null when they can. */
export function amuxSettledCardEscalationRefusal(card: {
  status: string; activeDelivery: boolean; liveAttempt: boolean; openEscalationIds: readonly string[];
}, shownEscalationId: string): AmuxSettledCardEscalationRefusal | null {
  if (card.status !== "done") return "not_done";
  if (card.openEscalationIds.length === 0) return "no_open_escalation";
  // The owner closes what was shown: a card whose open escalation is another
  // one than the shown is reloaded first.
  if (!card.openEscalationIds.includes(shownEscalationId)) return "changed";
  // A done card has no run; one with queued work or an open attempt is not left alone.
  if (card.activeDelivery || card.liveAttempt) return "running";
  return null;
}
