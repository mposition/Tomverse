import "server-only";

import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import {
  DM_REQUEST_AUDIT_ACTION,
  DM_REQUEST_AUDIT_TARGET_TYPE,
  DM_REQUEST_EVENT_AUDIT_TARGET_TYPE,
  DM_ROUTER_SYSTEM_ACTOR,
  dmEventAuditAction,
  dmEventAuditActor,
  type DmRequestEventKind,
} from "@/lib/amux/decisionMakerRequestCore";
import type { DmInstanceScope } from "@/lib/amux/decisionMakerSwitchCore";

/**
 * The system audit of the Decision Maker request ledger
 * (docs/policy/amux-decision-maker.md §10): `amux.decision.route` for a
 * request, and `amux.decision.<kind>` for each request event -- by the router
 * for assignment and closing, by the request's own instance for transmission
 * and results. Migration 20261008090100_amux_decision_maker_request_ledger
 * requires exactly that action and actor, in the same transaction, naming the
 * row.
 *
 * Kept apart from lib/amux/decisionMakerRequestStore.ts, as the switch store
 * keeps its latch audit apart, so the store names no system actor and a later
 * human path in it cannot reach the system writer by accident
 * (tests/adminAuditSystemActors.test.ts). Writes in the caller's transaction,
 * on the same chain as every other entry. Summaries are fixed sentences; no
 * card text, digest or free text reaches an audit entry.
 */

const EVENT_SUMMARIES: Readonly<Record<DmRequestEventKind, string>> = {
  assign: "Assigned an AMUX Decision Maker request.",
  assign_discarded: "Discarded an AMUX Decision Maker assignment.",
  transmit_intent: "Recorded an AMUX Decision Maker transmission intent.",
  transmit_receipt: "Recorded an AMUX Decision Maker transmission receipt.",
  transmit_unknown: "Recorded an AMUX Decision Maker transmission of unknown outcome.",
  result: "Recorded an AMUX Decision Maker result.",
  result_rejected: "Rejected an AMUX Decision Maker result.",
  result_unknown: "Recorded an AMUX Decision Maker result of unknown outcome.",
  stale_close: "Closed a stale AMUX Decision Maker request.",
};

export const writeDecisionMakerRouteAudit = (
  tx: Prisma.TransactionClient,
  entry: { requestId: string; metadata: Prisma.InputJsonObject },
): Promise<string> =>
  writeSystemAuditLog({
    tx,
    systemActor: DM_ROUTER_SYSTEM_ACTOR,
    action: DM_REQUEST_AUDIT_ACTION,
    targetType: DM_REQUEST_AUDIT_TARGET_TYPE,
    targetId: entry.requestId,
    summary: "Routed an AMUX Decision Maker request.",
    metadata: entry.metadata,
  });

export const writeDecisionMakerEventAudit = (
  tx: Prisma.TransactionClient,
  entry: {
    kind: DmRequestEventKind;
    instance: DmInstanceScope | null;
    eventId: string;
    metadata: Prisma.InputJsonObject;
  },
): Promise<string> =>
  writeSystemAuditLog({
    tx,
    systemActor: dmEventAuditActor(entry.kind, entry.instance),
    action: dmEventAuditAction(entry.kind),
    targetType: DM_REQUEST_EVENT_AUDIT_TARGET_TYPE,
    targetId: entry.eventId,
    summary: EVENT_SUMMARIES[entry.kind],
    metadata: entry.metadata,
  });
