"use client";

import { AmuxWorkerQuestionDm, amuxWorkerQuestionDmFrom } from "@/components/admin/AmuxWorkerQuestion";
import type { DmJudgmentIo } from "@/components/admin/AmuxDecisionMakerJudgmentPanel";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxOwnerQueueMessages } from "@/lib/adminMessages/amuxOwnerQueue";
import {
  AMUX_OWNER_QUEUE_DM_SETTLEMENT_STATES,
  type AmuxOwnerQueueDmSettlement,
  type AmuxOwnerQueueDmSettlementState,
} from "@/lib/amux/ownerQueueDmCore";
import type { AmuxV22QuestionDm } from "@/lib/amux/v22OwnerQuestionDmCore";

/** The settlement's fixed choices per kind, in the words the card offers them. */
const KIND_OPTIONS = {
  stopped: ["retry", "complete", "close"],
  t2_pr: ["approve", "retry", "close"],
} as const;

/** Whether the Decision Maker has not answered yet: its card is filed, or being worked, or waits for the relay. */
const dmPending = (dm: AmuxV22QuestionDm) =>
  dm.state === "filed" || dm.state === "working" || (dm.state === "not_sent" && dm.reason === "waiting_relay");

/**
 * A card's settlement as the route returned it, or null when it has none.
 * A value this screen cannot draw is `unread`, never a proposal it could not
 * check; a proposal the shared reader refuses is not offered for confirmation.
 */
export const amuxOwnerQueueDmFrom = (raw: unknown): AmuxOwnerQueueDmSettlement | null => {
  if (raw === null || raw === undefined) return null;
  const unread: AmuxOwnerQueueDmSettlement = { status: "unread" };
  if (typeof raw !== "object") return unread;
  const r = raw as Record<string, unknown>;
  if (r.status === "unread") return unread;
  if (r.status !== "read" || typeof r.settlementId !== "string" ||
      (r.kind !== "stopped" && r.kind !== "t2_pr") ||
      typeof r.state !== "string" || !(AMUX_OWNER_QUEUE_DM_SETTLEMENT_STATES as readonly string[]).includes(r.state) ||
      (r.decision !== null && typeof r.decision !== "string") ||
      (r.handoffReason !== null && typeof r.handoffReason !== "string") ||
      typeof r.confirmable !== "boolean") return unread;
  const dm = amuxWorkerQuestionDmFrom({ decisionMaker: r.dm }) ?? { state: "unavailable" as const };
  return {
    status: "read", settlementId: r.settlementId, kind: r.kind,
    state: r.state as AmuxOwnerQueueDmSettlementState,
    decision: r.decision as string | null, handoffReason: r.handoffReason as string | null,
    dm, confirmable: r.confirmable && dm.state === "proposal",
  };
};

const BOX = "mt-2 rounded border p-2 border-zinc-700";

/**
 * The Decision Maker's part of an owner queue card (owner decision 2026-11-13,
 * docs/policy/amux-decision-maker.md §0a-5). A proposal shows its choice and
 * why, with "Confirm as proposed" through the existing judgment route
 * (`AmuxWorkerQuestionDm`: `ops:write`, a recent step-up, the values Admin
 * showed); the settlement's `dm_confirmed` walk applies a confirmed answer on
 * the relay's next sync. No answer yet says the Decision Maker is reviewing; a
 * card the Decision Maker's path handed to a person says why. The decision the
 * card needs from the owner is still drawn below, unchanged. Writes nothing.
 */
export function AmuxOwnerQueueDm({ settlement, io }: {
  settlement: AmuxOwnerQueueDmSettlement; io?: DmJudgmentIo;
}) {
  const copy = useAdminMessages(adminAmuxOwnerQueueMessages);
  if (settlement.status === "unread") {
    return (
      <div className={BOX} data-testid="amux-owner-queue-dm" data-dm-state="unread">
        <p className="text-sm text-zinc-300" data-testid="amux-owner-queue-dm-line">{copy.dm.unread}</p>
      </div>
    );
  }
  const optionLabel = (id: string | null) => (id !== null ? copy.dm.options[id] : undefined) ?? id ?? "";
  if (settlement.state !== "open") {
    const line = settlement.state === "claimed" ? copy.dm.claimed
      : settlement.state === "applied" ? copy.dm.applied(optionLabel(settlement.decision))
      : copy.dm.cancelled;
    return (
      <div className={BOX} data-testid="amux-owner-queue-dm" data-dm-state={settlement.state}>
        <p className="text-sm text-zinc-300" data-testid="amux-owner-queue-dm-line">{line}</p>
      </div>
    );
  }
  const { dm, handoffReason, confirmable } = settlement;
  const handedOff = handoffReason !== null;
  const line = handedOff ? copy.dm.handoff[handoffReason] ?? copy.dm.handoffFallback
    : dmPending(dm) ? copy.dm.reviewing
    : dm.state === "proposal" && !confirmable ? copy.dm.answerUnreadable
    : undefined;
  const options = KIND_OPTIONS[settlement.kind].map((id) => ({ id, label: copy.dm.options[id] ?? id }));
  const view = handedOff ? "handed_off" : dmPending(dm) ? "reviewing" : dm.state;
  // Pending or handed off with no proposal to show: one line, no Decision Maker chrome to read around.
  if (line !== undefined && dm.state !== "proposal") {
    return (
      <div className={BOX} data-testid="amux-owner-queue-dm" data-dm-state={view}>
        <p className="text-sm text-zinc-300" data-testid="amux-owner-queue-dm-line">{line}</p>
      </div>
    );
  }
  return (
    <div data-testid="amux-owner-queue-dm" data-dm-state={view}>
      <AmuxWorkerQuestionDm dm={dm} options={options} io={io} canConfirm={confirmable && !handedOff}
        line={line} confirmedLine={copy.dm.confirmedLine} />
    </div>
  );
}
