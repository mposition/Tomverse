/**
 * Owner closing of AMUX ideas that wait for the owner (`awaiting_owner`):
 * the analysis ended, but nothing will move the idea on unless the owner
 * acts. Closing marks the idea cancelled; its rows, body and units stay and
 * leave by the existing retention rules (docs/policy/amux-intake.md).
 */

export const AMUX_IDEA_OWNER_CLOSE_ACTION = "amux.idea.owner_closed";
/** One request closes at most this many ideas; the Ideas tab lists 20. */
export const AMUX_IDEA_OWNER_CLOSE_LIMIT = 20;
/** The only state an owner close accepts. Earlier states have their own
 * cancellation paths (queued session cancel, the seven-day auto-cancel). */
export const AMUX_IDEA_OWNER_CLOSABLE_STATE = "awaiting_owner";

const IDEA_ID = /^[A-Za-z0-9_-]{8,80}$/;

export type AmuxIdeaOwnerCloseOutcome =
  | { ideaId: string; result: "closed"; cancelledAt: string; auditId: string }
  | { ideaId: string; result: "already_closed" }
  | { ideaId: string; result: "not_closable" }
  | { ideaId: string; result: "not_found" }
  /** Unknown outcome: read the list back before sending it again. */
  | { ideaId: string; result: "outcome_unknown" };

export type AmuxIdeaOwnerCloseInput =
  | { ok: true; ideaIds: string[]; reason: string }
  | { ok: false };

/** Same reason bounds as a unit rejection; duplicate IDs are refused, not merged. */
export function inspectAmuxIdeaOwnerClose(input: {
  ideaIds: unknown; reason: unknown;
}): AmuxIdeaOwnerCloseInput {
  const { ideaIds, reason } = input;
  if (!Array.isArray(ideaIds) || ideaIds.length < 1 ||
      ideaIds.length > AMUX_IDEA_OWNER_CLOSE_LIMIT ||
      !ideaIds.every((id) => typeof id === "string" && IDEA_ID.test(id)) ||
      new Set(ideaIds).size !== ideaIds.length) {
    return { ok: false };
  }
  if (typeof reason !== "string" || reason !== reason.trim() ||
      reason.length < 3 || reason.length > 500) {
    return { ok: false };
  }
  return { ok: true, ideaIds: [...ideaIds] as string[], reason };
}
