import {
  dmAdminRequestStatus,
  type DmAdminRequestRow,
} from "./decisionMakerAdminCore.ts";
import type { DmShownProposal } from "./decisionMakerJudgmentCore.ts";

/**
 * Where a v22 worker question stands with the Decision Maker, for the card
 * that shows the question (owner decision 2026-10-30: the DM proposes first,
 * the operator only confirms). Pure: the server read
 * (lib/amux/v22OwnerQuestionDmRead.ts) gathers the facts, this names the
 * state, and the card says it in one line.
 *
 * Nothing here applies anything. A proposal is shown with the values a
 * confirmation must name (`shown`); the confirmation goes through the
 * existing judgment route, and the relay applies a confirmed answer on its
 * next tick (lib/amux/v22OwnerQuestionDmService.ts).
 */

/** Why an open question has no local card for the Decision Maker yet. */
export const AMUX_V22_QUESTION_DM_NOT_SENT_REASONS = [
  // TOMVERSE_AMUX_DM_ROUTING is not enabled: the relay's routes answer 409.
  "routing_off",
  // The kill switch holds every Decision Maker path.
  "kill_switch",
  // The switches cannot be read, which holds the path the same way.
  "switches_unreadable",
  // The asking run has no v22 assignment provider, which the relay routes by:
  // the sync passes the question over on every tick.
  "no_provider",
  // Everything is on: the relay files the card on one of its next ticks.
  "waiting_relay",
] as const;
export type AmuxV22QuestionDmNotSentReason = (typeof AMUX_V22_QUESTION_DM_NOT_SENT_REASONS)[number];

export type AmuxV22QuestionDm =
  | { state: "not_sent"; reason: AmuxV22QuestionDmNotSentReason }
  /** The relay filed the local card; the Decision Maker has no request for it yet. */
  | { state: "filed" }
  /** The routing kept the question with the operator (§3), with why. */
  | { state: "with_operator"; requestId: string; reasons: string[] }
  | { state: "working"; requestId: string }
  | {
      state: "proposal";
      requestId: string;
      /** A free-text proposal's answer; a select names `optionId`. */
      answer: string | null;
      optionId: string | null;
      rationale: string;
      irreversible: boolean;
      shown: DmShownProposal;
    }
  /** The Decision Maker said it cannot answer (an escalation), with its reason. */
  | { state: "cannot_answer"; requestId: string; reason: string | null }
  /** No usable result: a timeout, a validation failure, an unknown outcome. */
  | { state: "failed"; requestId: string; status: string }
  /** A person confirmed it; the relay applies it on its next tick. */
  | { state: "confirmed"; requestId: string }
  | { state: "rejected"; requestId: string }
  | { state: "closed"; requestId: string; status: string }
  /** The reader may not see Decision Maker bodies (they need ops:write). */
  | { state: "restricted" }
  | { state: "unavailable" };

/** Why an open question with no local card is not with the Decision Maker. */
export const amuxV22QuestionDmNotSentReason = (input: {
  routingEnabled: boolean;
  killSwitch: boolean | null;
  hasProvider: boolean;
}): AmuxV22QuestionDmNotSentReason => {
  if (!input.routingEnabled) return "routing_off";
  if (input.killSwitch === null) return "switches_unreadable";
  if (input.killSwitch) return "kill_switch";
  if (!input.hasProvider) return "no_provider";
  return "waiting_relay";
};

/** The facts of a card's newest Decision Maker request the state needs. */
export type AmuxV22QuestionDmDetail = {
  dbNowMs: number;
  row: DmAdminRequestRow;
  answer: string | null;
  optionId: string | null;
  rationale: string | null;
  escalationReason: string | null;
  shown: DmShownProposal | null;
};

/** The state of a filed question from its card's newest request; null: no request yet. */
export const amuxV22QuestionDmOfDetail = (detail: AmuxV22QuestionDmDetail | null): AmuxV22QuestionDm => {
  if (detail === null) return { state: "filed" };
  const requestId = detail.row.requestId;
  const status = dmAdminRequestStatus(detail.row, detail.dbNowMs);
  switch (status) {
    case "routed_to_operator":
      return { state: "with_operator", requestId, reasons: [...detail.row.refusalCodes] };
    case "awaiting_assignment":
    case "assigned":
    case "running":
      return { state: "working", requestId };
    case "proposal":
      // A proposal whose bodies are not all there cannot be confirmed as shown.
      return detail.shown !== null && detail.rationale !== null
        ? {
            state: "proposal",
            requestId,
            answer: detail.answer,
            optionId: detail.optionId,
            rationale: detail.rationale,
            irreversible: detail.shown.irreversible,
            shown: detail.shown,
          }
        : { state: "failed", requestId, status: "proposal_unreadable" };
    case "escalate":
      return { state: "cannot_answer", requestId, reason: detail.escalationReason };
    case "confirm":
    case "edit_confirm":
      return { state: "confirmed", requestId };
    case "reject":
      return { state: "rejected", requestId };
    case "assign_discarded":
    case "stale_close":
    case "direct_answer_close":
      return { state: "closed", requestId, status };
    default:
      return { state: "failed", requestId, status };
  }
};

/** Only these leave the answer to the Decision Maker's path; every other state leaves it with the operator. */
export const amuxV22QuestionDmPending = (dm: AmuxV22QuestionDm) =>
  dm.state === "filed" || dm.state === "working" || dm.state === "proposal" || dm.state === "confirmed" ||
  (dm.state === "not_sent" && dm.reason === "waiting_relay");
