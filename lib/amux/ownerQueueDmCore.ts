import { amuxDmOwnerSettlementAnswerOf, type AmuxDmOwnerSettlementKind } from "./dmOwnerSettlementCore.ts";
import type { AmuxV22QuestionDm } from "./v22OwnerQuestionDmCore.ts";

/**
 * What the owner queue shows of the Decision Maker on one card (owner decision
 * 2026-11-13, docs/policy/amux-decision-maker.md §0a-5): the card's settlement
 * (lib/amux/dmOwnerSettlementService.ts) and where its Decision Maker card
 * stands. Pure: the server read (lib/amux/ownerQueueDmRead.ts) gathers the
 * facts, this names what the card says and whether "Confirm as proposed" is
 * offered. Nothing here applies anything: a confirmation goes through the
 * judgment route and the settlement's `dm_confirmed` walk applies it.
 */

export const AMUX_OWNER_QUEUE_DM_SETTLEMENT_STATES = ["open", "claimed", "applied", "cancelled"] as const;
export type AmuxOwnerQueueDmSettlementState = (typeof AMUX_OWNER_QUEUE_DM_SETTLEMENT_STATES)[number];

/** The settlement row facts the card needs, as the one statement reads them. */
export type AmuxOwnerQueueSettlementRow = {
  escalationId: string;
  settlementId: string;
  kind: AmuxDmOwnerSettlementKind;
  state: AmuxOwnerQueueDmSettlementState;
  decision: string | null;
  handoffReason: string | null;
  localCardId: string | null;
};

/**
 * `unread`: the settlement or its card could not be read, so the card says so
 * and the owner decides as before. Otherwise the settlement as it stands, with
 * the Decision Maker's card state beside it.
 */
export type AmuxOwnerQueueDmSettlement =
  | { status: "unread" }
  | {
      status: "read";
      settlementId: string;
      kind: AmuxDmOwnerSettlementKind;
      state: AmuxOwnerQueueDmSettlementState;
      decision: string | null;
      /** Why the settlement was left to a person; null while the Decision Maker's path holds it. */
      handoffReason: string | null;
      dm: AmuxV22QuestionDm;
      /**
       * "Confirm as proposed" is offered: the settlement is open and not handed
       * to a person, and the proposal's answer is one the settlement's fixed
       * words name, so a confirmation is applied rather than handed off.
       */
      confirmable: boolean;
    };

const SETTLEMENT_KINDS: readonly string[] = ["t2_pr", "stopped"];

/** Whether a stored row is one this read can name; anything else is skipped as unread. */
export const isAmuxOwnerQueueSettlementRow = (row: unknown): row is AmuxOwnerQueueSettlementRow => {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  return typeof r.escalationId === "string" && typeof r.settlementId === "string" &&
    typeof r.kind === "string" && SETTLEMENT_KINDS.includes(r.kind) &&
    typeof r.state === "string" && (AMUX_OWNER_QUEUE_DM_SETTLEMENT_STATES as readonly string[]).includes(r.state) &&
    (r.decision === null || typeof r.decision === "string") &&
    (r.handoffReason === null || typeof r.handoffReason === "string") &&
    (r.localCardId === null || typeof r.localCardId === "string");
};

/** Whether a proposal's answer is one the settlement applies, by the walk's own reading of it. */
export const amuxOwnerQueueDmAnswerReadable = (kind: AmuxDmOwnerSettlementKind, dm: AmuxV22QuestionDm) =>
  dm.state === "proposal" && amuxDmOwnerSettlementAnswerOf({
    kind, judgmentKind: "confirm", outputKind: dm.optionId !== null ? "select" : "free_text",
    optionId: dm.optionId, dmAnswer: dm.answer ?? undefined,
  }) !== null;

/**
 * The card's Decision Maker area from a settlement row and its card's state.
 * An open settlement with no local card yet is waiting for the relay to file
 * it; a settled one reads no card (nothing is left to confirm). Whether a
 * person may confirm is decided here, once, so the screen offers no button the
 * walk would only hand off.
 */
export function amuxOwnerQueueDmSettlementOf(row: AmuxOwnerQueueSettlementRow,
  dm: AmuxV22QuestionDm | null): AmuxOwnerQueueDmSettlement {
  const open = row.state === "open";
  const state: AmuxV22QuestionDm = dm ?? (open && row.localCardId === null ?
    { state: "not_sent", reason: "waiting_relay" } : { state: "filed" });
  return {
    status: "read",
    settlementId: row.settlementId,
    kind: row.kind,
    state: row.state,
    decision: row.decision,
    handoffReason: row.handoffReason,
    dm: state,
    confirmable: open && row.handoffReason === null && amuxOwnerQueueDmAnswerReadable(row.kind, state),
  };
}
