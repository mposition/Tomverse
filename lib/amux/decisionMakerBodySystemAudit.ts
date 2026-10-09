import "server-only";

import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import {
  DM_BODY_AUDIT_ACTIONS,
  DM_BODY_DELETE_AUDIT_TARGET_TYPE,
  DM_DIGEST_KEY_EVENT_AUDIT_TARGET_TYPE,
} from "@/lib/amux/decisionMakerBodyCore";
import { DM_ROUTER_SYSTEM_ACTOR } from "@/lib/amux/decisionMakerRequestCore";

/**
 * The system audits of the Decision Maker body store
 * (docs/policy/amux-decision-maker.md §10): `amux.decision.body_purge` for a
 * retention-expiry delete, and `amux.decision.digest_key_rotate` and
 * `.digest_key_destroy` for the key registry -- all by the router's actor, the
 * Decision Maker's one actor that is not a DM instance. Migration
 * 20261008120000_amux_decision_maker_body_store requires exactly that action
 * and actor, in the same transaction, naming the request or the registry
 * event.
 *
 * Kept apart from lib/amux/decisionMakerBodyStore.ts, which writes a
 * person's legal hold and erase through the administrator writer, so no file
 * calls both writers and a human entry cannot come out of the system path
 * (tests/adminAuditSystemActors.test.ts). Summaries are fixed sentences; no
 * body, digest or key check value reaches an audit entry.
 */

export const writeDecisionMakerBodyPurgeAudit = (
  tx: Prisma.TransactionClient,
  entry: { requestId: string; metadata: Prisma.InputJsonObject },
): Promise<string> =>
  writeSystemAuditLog({
    tx,
    systemActor: DM_ROUTER_SYSTEM_ACTOR,
    action: DM_BODY_AUDIT_ACTIONS.bodyPurge,
    targetType: DM_BODY_DELETE_AUDIT_TARGET_TYPE,
    targetId: entry.requestId,
    summary: "Purged AMUX Decision Maker bodies after their retention.",
    metadata: entry.metadata,
  });

export const writeDecisionMakerDigestKeyAudit = (
  tx: Prisma.TransactionClient,
  entry: { kind: "rotate" | "destroy"; eventId: string; metadata: Prisma.InputJsonObject },
): Promise<string> =>
  writeSystemAuditLog({
    tx,
    systemActor: DM_ROUTER_SYSTEM_ACTOR,
    action: entry.kind === "rotate" ? DM_BODY_AUDIT_ACTIONS.digestKeyRotate : DM_BODY_AUDIT_ACTIONS.digestKeyDestroy,
    targetType: DM_DIGEST_KEY_EVENT_AUDIT_TARGET_TYPE,
    targetId: entry.eventId,
    summary:
      entry.kind === "rotate"
        ? "Put an AMUX Decision Maker digest key period into use."
        : "Recorded the destruction of an AMUX Decision Maker digest key period.",
    metadata: entry.metadata,
  });
