/**
 * The engineering adapter: the in-app boundary through which the engineering
 * runner reaches AMUX (docs/policy/engineering-agent.md §8,
 * docs/policy/development-agent-orchestration.md, Authority, version 12).
 *
 * The runner holds no AMUX route secret. It calls the engineering routes, and
 * this module hands the request to AMUX's own writer in the same process and
 * the same transaction, attaching the engineering rows to that transaction
 * after every AMUX row lock. The worker identity is this module's constant and
 * never comes from a request. The adapter has no transition of its own: the
 * AMUX writer's CAS, lease, fencing, attempt budget, halt and audit apply
 * exactly as they do for `/api/internal/amux/*`, and a settlement can only go
 * to `review`, `todo` or `blocked` -- never `done`.
 *
 * Nothing here runs unless the code latch is on, and version 12 ships it off.
 * The AMUX execution API gate still applies on top of it.
 */

import "server-only";

import { randomInt } from "node:crypto";

import type { AmuxAttachedTransaction, AmuxAttachment } from "@/lib/amux/dbBoundary";
import {
  heartbeatAmuxExecution,
  settleAmuxExecution,
  startAmuxExecution,
  type AmuxExecutionOutcome,
  type AmuxExecutionRenewedFact,
  type AmuxExecutionSettledFact,
  type AmuxExecutionStartedFact,
  type AmuxExecutionToStatus,
} from "@/lib/amux/execution";
import { isAmuxExecutionApiEnabled } from "@/lib/amux/executionGate";
import {
  AMUX_SETTLEMENT_FOR_OUTCOME,
  combineRunHalt,
  type HaltValue,
  type RunOutcome,
} from "@/lib/engineeringAgentCore";
import {
  EngineeringAgentStoreRefusedError,
  endEngineeringAgentRun,
  engineeringAgentTransactionInAmux,
  heartbeatEngineeringAgentRun,
  readEngineeringAgentHaltState,
  recordEngineeringAgentRunStart,
  type EngineeringAgentTransaction,
} from "@/lib/engineeringAgentStore";

/**
 * Version 12 of the orchestration policy ships this false. Turning it on is a
 * separate version of that policy; the engineering operating mode must also
 * allow the write.
 */
export const ENGINEERING_AGENT_AMUX_ADAPTER_CODE_LATCH = false;

/** The one AMUX worker this adapter speaks for (policy §8). */
export const ENGINEERING_AGENT_AMUX_WORKER = "engineering-runner";

export const engineeringAgentAmuxAdapterPermitted = (input: {
  codeLatch: boolean;
  executionApiEnabled: boolean;
}): boolean => input.codeLatch === true && input.executionApiEnabled === true;

export const isEngineeringAgentAmuxAdapterOpen = (): boolean =>
  engineeringAgentAmuxAdapterPermitted({
    codeLatch: ENGINEERING_AGENT_AMUX_ADAPTER_CODE_LATCH,
    executionApiEnabled: isAmuxExecutionApiEnabled(),
  });

/** Twelve digits, the run id's widest form, minted here and never by a service. */
export const mintEngineeringAgentRunId = (): string => String(randomInt(100_000_000_000, 1_000_000_000_000));

/**
 * The AMUX settlement a run's outcome maps to, from the core's one table. An
 * outcome the table does not settle (`abandoned`, which is AMUX's recovery to
 * make) is refused rather than guessed.
 */
export const amuxSettlementForRunOutcome = (
  outcome: RunOutcome,
): { outcome: AmuxExecutionOutcome; toStatus: Exclude<AmuxExecutionToStatus, "done"> } => {
  switch (AMUX_SETTLEMENT_FOR_OUTCOME[outcome]) {
    case "review":
      return { outcome: "succeeded", toStatus: "review" };
    case "retry":
      return { outcome: "failed", toStatus: "todo" };
    case "blocked":
      return { outcome: "blocked", toStatus: "blocked" };
    default:
      throw new EngineeringAgentStoreRefusedError("outcome_not_settled_by_agent");
  }
};

type MarkCommitted = (tx: EngineeringAgentTransaction) => Promise<void>;

/* ------------------------------------------------------------------------- */
/* Attachments                                                                */
/* ------------------------------------------------------------------------- */

/** The card's kind, read from the AMUX row this transaction already locked. */
const lockedCardKind = async (tx: AmuxAttachedTransaction, taskId: string): Promise<string> => {
  const card = await tx.amuxWorkItem.findUnique({ where: { id: taskId }, select: { kind: true } });
  if (!card) throw new EngineeringAgentStoreRefusedError("card_missing");
  return card.kind;
};

// Calls each attachment makes through the AMUX writer's bounded client: the
// store's switch read, clock, write and audit entry (four), plus this module's
// own reads and the request's move to `committed`. The end reads the halt
// state (three) before the store's write and audit.
const RUN_START_PRISMA_CALLS = 10;
const RUN_HEARTBEAT_PRISMA_CALLS = 2;
const RUN_END_PRISMA_CALLS = 9;

/** A run is created in the transaction that starts its AMUX attempt (§11). */
export const engineeringRunStartAttachment = (input: {
  runId: string;
  baseSha: string;
  markCommitted?: MarkCommitted;
}): AmuxAttachment<AmuxExecutionStartedFact> => ({
  prismaCalls: RUN_START_PRISMA_CALLS,
  work: async (lent, fact, context) => {
    const tx = engineeringAgentTransactionInAmux(lent);
    await recordEngineeringAgentRunStart(tx, {
      runId: input.runId,
      amuxAttemptId: fact.attemptId,
      cardId: fact.taskId,
      cardKind: await lockedCardKind(lent, fact.taskId),
      baseSha: input.baseSha,
      // The run's lease is the attempt's: the runner renews both in one call.
      leaseMs: fact.leaseExpiresAt.getTime() - context.dbNow.getTime(),
    });
    await input.markCommitted?.(tx);
  },
});

/** The run's lease moves with the attempt's, or neither moves. */
export const engineeringRunHeartbeatAttachment = (input: {
  runId: string;
}): AmuxAttachment<AmuxExecutionRenewedFact> => ({
  prismaCalls: RUN_HEARTBEAT_PRISMA_CALLS,
  work: async (lent, fact, context) => {
    await heartbeatEngineeringAgentRun(engineeringAgentTransactionInAmux(lent), {
      runId: input.runId,
      amuxAttemptId: fact.attemptId,
      leaseMs: fact.leaseExpiresAt.getTime() - context.dbNow.getTime(),
    });
  },
});

/**
 * The run ends in the transaction that settles its attempt. The halt it
 * records is the runner's report combined with what the app holds, so the
 * runner can raise a halt and never lower one.
 */
export const engineeringRunEndAttachment = (input: {
  runId: string;
  outcome: RunOutcome;
  halt: HaltValue;
  markCommitted?: MarkCommitted;
}): AmuxAttachment<AmuxExecutionSettledFact> => ({
  prismaCalls: RUN_END_PRISMA_CALLS,
  work: async (lent, fact) => {
    const tx = engineeringAgentTransactionInAmux(lent);
    const held = await readEngineeringAgentHaltState(tx);
    await endEngineeringAgentRun(tx, {
      runId: input.runId,
      amuxAttemptId: fact.attemptId,
      outcome: input.outcome,
      halt: combineRunHalt({
        reported: input.halt,
        circuitLatched: held.circuitLatched,
        openStateMismatches: held.openStateMismatches,
      }),
    });
    await input.markCommitted?.(tx);
  },
});

/* ------------------------------------------------------------------------- */
/* Operations                                                                 */
/* ------------------------------------------------------------------------- */

/** The worker lease a runner request carries; the worker name is never among it. */
export type EngineeringAgentWorkerLease = { instanceId: string; generation: number };

const requireOpen = () => {
  if (!isEngineeringAgentAmuxAdapterOpen()) throw new EngineeringAgentStoreRefusedError("adapter_closed");
};

/**
 * Starts the AMUX attempt for a card the runner owns and creates its run.
 * `started: false` is AMUX's refusal, with AMUX's reason, and no run exists.
 */
export async function startEngineeringAgentRun(input: {
  lease: EngineeringAgentWorkerLease;
  taskId: string;
  expectedRevision: number;
  baseSha: string;
  markCommitted?: MarkCommitted;
}) {
  requireOpen();
  const runId = mintEngineeringAgentRunId();
  const started = await startAmuxExecution(
    {
      taskId: input.taskId,
      worker: ENGINEERING_AGENT_AMUX_WORKER,
      instanceId: input.lease.instanceId,
      generation: input.lease.generation,
      expectedRevision: input.expectedRevision,
    },
    engineeringRunStartAttachment({ runId, baseSha: input.baseSha, markCommitted: input.markCommitted }),
  );
  if (!started.started) return started;
  return {
    started: true as const,
    runId,
    attemptId: started.attemptId,
    taskRevision: started.taskRevision,
    leaseExpiresAt: started.leaseExpiresAt,
  };
}

/** Renews the attempt's and the run's lease together. `false` renewed neither. */
export async function heartbeatEngineeringAgentRunLease(input: {
  lease: EngineeringAgentWorkerLease;
  runId: string;
  attemptId: string;
  taskRevision: number;
}): Promise<boolean> {
  requireOpen();
  return heartbeatAmuxExecution(
    {
      attemptId: input.attemptId,
      worker: ENGINEERING_AGENT_AMUX_WORKER,
      instanceId: input.lease.instanceId,
      generation: input.lease.generation,
      taskRevision: input.taskRevision,
    },
    engineeringRunHeartbeatAttachment({ runId: input.runId }),
  );
}

/**
 * Settles the attempt where the run's outcome says, and ends the run. The
 * runner names the outcome, never the AMUX status. No cost goes into the
 * attempt's reservation or settlement delta (orchestration policy, Authority).
 */
export async function finishEngineeringAgentRun(input: {
  lease: EngineeringAgentWorkerLease;
  runId: string;
  attemptId: string;
  taskRevision: number;
  outcome: RunOutcome;
  halt: HaltValue;
  markCommitted?: MarkCommitted;
}) {
  requireOpen();
  const settlement = amuxSettlementForRunOutcome(input.outcome);
  return settleAmuxExecution(
    {
      attemptId: input.attemptId,
      worker: ENGINEERING_AGENT_AMUX_WORKER,
      instanceId: input.lease.instanceId,
      generation: input.lease.generation,
      taskRevision: input.taskRevision,
      outcome: settlement.outcome,
      toStatus: settlement.toStatus,
      actualCostMicrousd: null,
    },
    engineeringRunEndAttachment({
      runId: input.runId,
      outcome: input.outcome,
      halt: input.halt,
      markCommitted: input.markCommitted,
    }),
  );
}
