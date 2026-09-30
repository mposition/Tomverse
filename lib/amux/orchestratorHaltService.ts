import "server-only";

import {
  AMUX_DB_BOUNDARIES,
  AmuxDbBoundaryError,
  amuxDbTransactionBudgetMs,
  amuxRouteHasBudgetForMs,
  withAmuxDbBoundary,
} from "@/lib/amux/dbBoundary";
import type {
  AmuxOrchestratorAckDecision,
  AmuxOrchestratorAckKind,
  AmuxOrchestratorHaltRecord,
} from "@/lib/amux/orchestratorHaltCore";
import {
  acknowledgeAmuxOrchestratorWriteLocked,
  listAmuxOrchestratorResolveCandidates,
  openAmuxOrchestratorHaltLocked,
  readAmuxOrchestratorHaltState,
  resolveAmuxOrchestratorWriteLocked,
  type AmuxOrchestratorHaltRow,
  type AmuxOrchestratorHaltState,
} from "@/lib/amux/orchestratorHaltStore";

/**
 * The orchestrator's three internal calls of policy version 20, each inside
 * the bounded AMUX transactions of lib/amux/dbBoundary.ts. The SQL is in
 * lib/amux/orchestratorHaltStore.ts; this module only decides which
 * transactions run and in what order.
 */

/** Section 4: one acknowledgement, under the admission's row lock. */
export const acknowledgeAmuxOrchestratorWrite = (input: {
  requestId: string;
  kind: AmuxOrchestratorAckKind;
}): Promise<AmuxOrchestratorAckDecision> =>
  withAmuxDbBoundary(AMUX_DB_BOUNDARIES.orchestratorAck, (tx) =>
    acknowledgeAmuxOrchestratorWriteLocked(tx, input),
  );

/** Section 5: opens one halt, or returns the one already under its key. */
export const openAmuxOrchestratorHalt = (
  record: AmuxOrchestratorHaltRecord,
): Promise<{ halt: AmuxOrchestratorHaltRow; created: boolean }> =>
  withAmuxDbBoundary(AMUX_DB_BOUNDARIES.orchestratorHaltOpen, (tx) =>
    openAmuxOrchestratorHaltLocked(tx, record),
  );

/** Admissions one state read decides at most; the rest wait for the next. */
export const AMUX_ORCHESTRATOR_RESOLVE_BATCH = 20;

const resolveBudgetMs = amuxDbTransactionBudgetMs(AMUX_DB_BOUNDARIES.orchestratorResolve);
const stateReadBudgetMs = amuxDbTransactionBudgetMs(
  AMUX_DB_BOUNDARIES.orchestratorHaltStateRead,
);

/**
 * Section 5: "판정을 먼저 적용한 뒤" -- the resolver first, then the state.
 *
 * Each admission past its deadline plus the grace is decided in its own
 * transaction under its own row lock, oldest first, as long as the route
 * still has room for one more decision and the read after it. A decision that
 * fails leaves its admission as it was, and the read that follows reports it
 * as undecided or as needing a person from what is actually stored, so no
 * failure here is reported as a decision.
 */
export async function readAmuxOrchestratorHaltStateResolved(
  haltKeys: readonly string[],
): Promise<AmuxOrchestratorHaltState> {
  const candidates = await withAmuxDbBoundary(
    AMUX_DB_BOUNDARIES.orchestratorResolveCandidates,
    (tx) => listAmuxOrchestratorResolveCandidates(tx, AMUX_ORCHESTRATOR_RESOLVE_BATCH),
  );
  for (const requestId of candidates) {
    if (!amuxRouteHasBudgetForMs(resolveBudgetMs + stateReadBudgetMs)) break;
    try {
      await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.orchestratorResolve, (tx) =>
        resolveAmuxOrchestratorWriteLocked(tx, requestId),
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          subsystem: "amux",
          event: "orchestrator_resolve_failed",
          error_code:
            error instanceof AmuxDbBoundaryError ? error.code : "unexpected",
        }),
      );
    }
  }
  return withAmuxDbBoundary(AMUX_DB_BOUNDARIES.orchestratorHaltStateRead, (tx) =>
    readAmuxOrchestratorHaltState(tx, haltKeys),
  );
}
