/**
 * The support-triage transaction wrapper's first round trip
 * (docs/policy/support-triage.md §4).
 *
 * `armSupportTriageTransaction()` must be the first statement of every
 * support-triage transaction. One call to `support_triage_arm_timeouts()`
 * arms the lane's three timeouts and reports the inherited
 * `transaction_timeout`, and this module refuses the transaction before any
 * write when the inherited timeout is too short for the lane (Q22).
 *
 * The settings are not read back at run time: that would be a second round
 * trip, and every `C_guarded` is derived from one. What a read-back would
 * catch -- a SET clause on the function restoring a setting on return -- is
 * pinned instead by the catalog and read-back assertions in
 * tests/integration/support-triage-timeouts.db.test.ts.
 */
import "server-only";

import type { Prisma } from "@prisma/client";

import {
  LANE_TIMEOUTS,
  decideInheritedTransactionTimeout,
  type InheritedTimeoutDecision,
  type SupportTriageLane,
} from "@/lib/supportTriageCore";

export class SupportTriageTransactionRefused extends Error {
  readonly reason: "inherited_transaction_timeout_too_short" | "timeouts_not_armed";
  constructor(reason: SupportTriageTransactionRefused["reason"]) {
    super(`support-triage transaction refused: ${reason}`);
    this.name = "SupportTriageTransactionRefused";
    this.reason = reason;
  }
}

export type ArmedTransaction = {
  readonly lane: SupportTriageLane;
  readonly serverVersionNum: number;
  /** `null` on PostgreSQL 16, which has no transaction_timeout. */
  readonly inheritedTransactionTimeoutMs: number | null;
  readonly nowUtc: Date;
  readonly decision: InheritedTimeoutDecision;
};

type ArmRow = {
  serverVersionNum: number;
  inheritedTransactionTimeoutMs: number | null;
  nowUtc: Date;
};

export const armSupportTriageTransaction = async (
  tx: Prisma.TransactionClient,
  lane: SupportTriageLane
): Promise<ArmedTransaction> => {
  const timeouts = LANE_TIMEOUTS[lane];
  const [row] = await tx.$queryRaw<ArmRow[]>`
    SELECT * FROM "support_triage_arm_timeouts"(
      ${timeouts.statementTimeoutMs}::integer,
      ${timeouts.idleInTransactionTimeoutMs}::integer,
      ${timeouts.transactionTimeoutMs}::integer
    )`;
  if (!row) throw new SupportTriageTransactionRefused("timeouts_not_armed");

  const decision = decideInheritedTransactionTimeout(lane, row.inheritedTransactionTimeoutMs);
  if (decision.action === "refuse") {
    throw new SupportTriageTransactionRefused(decision.reason);
  }

  return {
    lane,
    serverVersionNum: row.serverVersionNum,
    inheritedTransactionTimeoutMs: row.inheritedTransactionTimeoutMs,
    nowUtc: row.nowUtc,
    decision,
  };
};
