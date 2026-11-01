/**
 * Owner closing of AMUX ideas that wait for the owner: after analysis
 * (`awaiting_owner`), or an owner-entered idea still waiting for its
 * execution approval (`submitted`). Nothing moves either on unless the owner
 * acts. Closing marks the idea cancelled; its rows and units stay and units
 * expire on their own clock. The body keeps its purge time after analysis, and
 * is due for purge at the close before it (docs/policy/amux-intake.md).
 */

export const AMUX_IDEA_OWNER_CLOSE_ACTION = "amux.idea.owner_closed";
/** One request closes at most this many ideas; the Ideas tab lists 20. */
export const AMUX_IDEA_OWNER_CLOSE_LIMIT = 20;
/**
 * The states an owner close accepts. A queued session idea has its own cancel,
 * and a running analysis is stopped, not closed. A submitted owner idea whose
 * execution approval already confirmed a preview or held a budget is refused
 * by the service, which can see those rows.
 */
export function amuxIdeaOwnerClosableState(state: string, submissionOrigin: string): boolean {
  return state === "awaiting_owner" || (state === "submitted" && submissionOrigin === "owner");
}

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
