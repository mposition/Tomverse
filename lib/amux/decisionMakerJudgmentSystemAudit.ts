import "server-only";

import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import {
  DM_DELIVERY_AUDIT_ACTIONS,
  DM_DELIVERY_EVENT_AUDIT_TARGET_TYPE,
  type DmDeliverySystemEventKind,
} from "@/lib/amux/decisionMakerJudgmentCore";
import { DM_ROUTER_SYSTEM_ACTOR } from "@/lib/amux/decisionMakerRequestCore";

/**
 * The system audit of the Decision Maker's delivery records
 * (docs/policy/amux-decision-maker.md §9, §10): `amux.decision.deliver` for the
 * delivery decision and for its receipt (§10 names no action of its own for
 * the receipt), and `amux.decision.delivery_unknown` -- by the router's actor,
 * the Decision Maker's one actor that is not a DM instance: the confirmed
 * answer is the operator's, not a DM's. Migration
 * 20261008130100_amux_decision_maker_judgment_delivery requires exactly that
 * action and actor, in the same transaction, naming the event.
 *
 * Kept apart from lib/amux/decisionMakerJudgmentStore.ts, which writes a
 * person's judgment and a person's resolution through the administrator
 * writer, so no file calls both writers and a human entry cannot come out of
 * the system path (tests/adminAuditSystemActors.test.ts). Summaries are fixed
 * sentences; no answer, digest or free text reaches an audit entry.
 */

const SUMMARIES: Readonly<Record<DmDeliverySystemEventKind, string>> = {
  deliver: "Released a confirmed AMUX Decision Maker answer for delivery.",
  delivery_receipt: "Recorded the delivery receipt of a confirmed AMUX Decision Maker answer.",
  delivery_unknown: "Recorded a confirmed AMUX Decision Maker answer whose delivery is unknown.",
};

export const writeDecisionMakerDeliveryAudit = (
  tx: Prisma.TransactionClient,
  entry: { kind: DmDeliverySystemEventKind; eventId: string; metadata: Prisma.InputJsonObject },
): Promise<string> =>
  writeSystemAuditLog({
    tx,
    systemActor: DM_ROUTER_SYSTEM_ACTOR,
    action: DM_DELIVERY_AUDIT_ACTIONS[entry.kind],
    targetType: DM_DELIVERY_EVENT_AUDIT_TARGET_TYPE,
    targetId: entry.eventId,
    summary: SUMMARIES[entry.kind],
    metadata: entry.metadata,
  });
