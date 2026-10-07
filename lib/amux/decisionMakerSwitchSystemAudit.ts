import "server-only";

import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import {
  DM_SWITCH_AUDIT_ACTIONS,
  DM_SWITCH_AUDIT_TARGET_TYPE,
  DM_SWITCH_LATCH_ACTOR_FOR_INSTANCE,
  type DmInstanceScope,
} from "@/lib/amux/decisionMakerSwitchCore";

/**
 * The system audit of a Decision Maker latch (docs/policy/amux-decision-maker.md
 * §8, §10): `amux.decision.latch`, recorded by the latched instance's own
 * actor, which migration 20261008030000_amux_decision_maker_switch requires.
 *
 * Kept apart from lib/amux/decisionMakerSwitchStore.ts, which also writes a
 * person's switch change through the administrator writer, so no file calls
 * both writers and a human entry cannot come out of the system path
 * (tests/adminAuditSystemActors.test.ts). Writes in the caller's transaction,
 * on the same chain as every other entry.
 */
export const writeDecisionMakerLatchAudit = (
  tx: Prisma.TransactionClient,
  entry: {
    instance: DmInstanceScope;
    eventId: string;
    metadata: Record<string, string>;
  },
): Promise<string> =>
  writeSystemAuditLog({
    tx,
    systemActor: DM_SWITCH_LATCH_ACTOR_FOR_INSTANCE[entry.instance],
    action: DM_SWITCH_AUDIT_ACTIONS.latch,
    targetType: DM_SWITCH_AUDIT_TARGET_TYPE,
    targetId: entry.eventId,
    summary: "Latched an AMUX Decision Maker instance off.",
    metadata: entry.metadata,
  });
