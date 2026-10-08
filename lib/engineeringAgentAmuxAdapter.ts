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
 * Nothing here reaches AMUX unless the code latch is on (version 25), the
 * AMUX execution API gate is open and the engineering mode is not off.
 */

import "server-only";

import { createHash, randomInt } from "node:crypto";

import type { AmuxAttachedTransaction, AmuxAttachment } from "@/lib/amux/dbBoundary";
import { acknowledgeAmuxWorkDelivery, pullAmuxWorkDelivery } from "@/lib/amux/delivery";
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
import { recordAmuxReviewPullRequest, type AmuxReviewPullRequestFact } from "@/lib/amux/reviewPullRequest";
import { getConfiguredAmuxWorkerCatalog } from "@/lib/amux/routing";
import { listOwnedTodos } from "@/lib/amux/store";
import {
  heartbeatAmuxWorkerRuntime,
  registerAmuxWorkerRuntime,
  type AmuxWorkerRuntimeStatus,
} from "@/lib/amux/workerRuntime";
import {
  AMUX_SETTLEMENT_FOR_OUTCOME,
  combineRunHalt,
  type RunOutcome,
  type RunnerReportableHalt,
} from "@/lib/engineeringAgentCore";
import {
  EngineeringAgentStoreRefusedError,
  currentEngineeringAgentHalt,
  endEngineeringAgentRun,
  engineeringAgentHalted,
  openEngineeringAgentWorkItem,
  engineeringAgentTransactionInAmux,
  heartbeatEngineeringAgentRun,
  openEngineeringAgentRunMismatches,
  readEngineeringAgentHaltState,
  recordEngineeringAgentPublishResult,
  readEngineeringAgentOwnerQueues,
  readEngineeringAgentSwitches,
  recordEngineeringAgentRunStart,
  requireEngineeringAgentRunAdmission,
  runEngineeringAgentTransaction,
  type EngineeringAgentTransaction,
} from "@/lib/engineeringAgentStore";
import type { EngineeringAgentMode, WriteResultOutcome } from "@/lib/engineeringAgentCore";
import { prisma } from "@/lib/prisma";

/**
 * Version 12 of the orchestration policy shipped this false; version 25 turns
 * it on. A call still reaches AMUX only while the execution API gate is open
 * and the engineering operating mode is not off.
 */
export const ENGINEERING_AGENT_AMUX_ADAPTER_CODE_LATCH = true;

/** The one AMUX worker this adapter speaks for (policy §8). */
export const ENGINEERING_AGENT_AMUX_WORKER = "engineering-runner";

/**
 * Whether the adapter may call an AMUX writer at all. The orchestration
 * policy's Authority section opens that path only when the code latch and the
 * engineering operating mode are both open, and version 18's execution API
 * gate sits under every AMUX writer. The mode is the effective one, so a kill
 * switch or an unreadable setting reads as off and closes every call --
 * registration, heartbeats, delivery, settlement and the cost ledger alike.
 */
export const engineeringAgentAmuxAdapterPermitted = (input: {
  codeLatch: boolean;
  executionApiEnabled: boolean;
  mode: EngineeringAgentMode;
}): boolean => input.codeLatch === true && input.executionApiEnabled === true && input.mode !== "off";

/** The half of that gate that needs no database read. */
export const isEngineeringAgentAmuxAdapterOpen = (): boolean =>
  ENGINEERING_AGENT_AMUX_ADAPTER_CODE_LATCH && isAmuxExecutionApiEnabled();

/**
 * The budget of an adapter route. An AMUX writer's transaction budget grows
 * with its call ceiling, and an attachment widens that ceiling, so the AMUX
 * lifecycle routes' own budget -- sized to their Rust client's timeout and to
 * their writers alone -- cannot hold a start with its run. The runner's
 * client waits longer than this.
 */
export const ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS = 20_000;

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

type MarkCommitted = (tx: EngineeringAgentTransaction, resultRef?: string) => Promise<void>;

/* ------------------------------------------------------------------------- */
/* Attachments                                                                */
/* ------------------------------------------------------------------------- */

/** The card's kind, read from the AMUX row this transaction already locked. */
const lockedCardKind = async (tx: AmuxAttachedTransaction, taskId: string): Promise<string> => {
  const card = await tx.amuxWorkItem.findUnique({ where: { id: taskId }, select: { kind: true } });
  if (!card) throw new EngineeringAgentStoreRefusedError("card_missing");
  return card.kind;
};

// Calls each attachment makes through the AMUX writer's bounded client. A
// halt lock is two (the audit chain's, then the halt's); a halt state read is
// four. The start's admission before any AMUX write: switches, halt lock,
// halt state, switches, owner queues -- nine. The start itself: switches,
// halt lock, halt state, clock, the run's INSERT, its audit entry (four), the
// card's kind and the request's move -- fifteen. The heartbeat: clock and
// update. The end: halt state, halt lock, update, audit entry and the
// request's move -- twelve.
const RUN_START_PRISMA_CALLS = 24;
const RUN_HEARTBEAT_PRISMA_CALLS = 2;
// Twelve, and one for the agent usage row the settlement writes beside it.
const RUN_END_PRISMA_CALLS = 13;
// A registration: the request's move, and one to spare.
const WORKER_REGISTER_PRISMA_CALLS = 2;
// A publish result: the writer's audit-chain lock, the settlement (item
// lock, capability read, update, audit entry -- seven), the run's card, the
// binding and its audit entry (five) and the request's move -- fifteen, and
// two to spare.
const PUBLISH_RESULT_PRISMA_CALLS = 17;

/** A run is created in the transaction that starts its AMUX attempt (§11). */
export const engineeringRunStartAttachment = (input: {
  runId: string;
  baseSha: string;
  markCommitted?: MarkCommitted;
}): AmuxAttachment<AmuxExecutionStartedFact> => ({
  prismaCalls: RUN_START_PRISMA_CALLS,
  // Before AMUX writes anything -- a card it would block on cost or on its
  // attempt budget included -- a run that could not start refuses the whole
  // start, so a skip never leaves an AMUX trace (§2.1).
  beforeWrite: async (lent) => {
    await requireEngineeringAgentRunAdmission(engineeringAgentTransactionInAmux(lent));
  },
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
    // A runner that loses this answer finds its run id in the request's record.
    await input.markCommitted?.(tx, input.runId);
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
  halt: RunnerReportableHalt;
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

/** A published result is settled and bound in the transaction that records its card's review pull request. */
export const engineeringPublishResultAttachment = (input: {
  workItemId: string;
  fencingToken: bigint;
  outcome: WriteResultOutcome;
  pullRequest: Parameters<typeof recordEngineeringAgentPublishResult>[1]["pullRequest"];
  markCommitted?: MarkCommitted;
}): AmuxAttachment<AmuxReviewPullRequestFact> => ({
  prismaCalls: PUBLISH_RESULT_PRISMA_CALLS,
  work: async (lent, fact) => {
    const tx = engineeringAgentTransactionInAmux(lent);
    if (input.pullRequest?.prNumber !== fact.prNumber) {
      throw new EngineeringAgentStoreRefusedError("pull_request_mismatch");
    }
    await recordEngineeringAgentPublishResult(tx, {
      workItemId: input.workItemId,
      fencingToken: input.fencingToken,
      outcome: input.outcome,
      pullRequest: input.pullRequest,
      cardId: fact.taskId,
      attemptId: fact.attemptId,
    });
    await input.markCommitted?.(tx, input.workItemId);
  },
});

/* ------------------------------------------------------------------------- */
/* Operations                                                                 */
/* ------------------------------------------------------------------------- */

/** The worker lease a runner request carries; the worker name is never among it. */
export type EngineeringAgentWorkerLease = { instanceId: string; generation: number };

/**
 * Whether a call may reach AMUX now: the latch, the execution API and the
 * effective mode. Routes ask this before they record anything, so a closed
 * gate leaves no request row behind; every adapter operation asks it again.
 */
export const engineeringAgentAmuxAdapterPermittedNow = async (): Promise<boolean> => {
  if (!isEngineeringAgentAmuxAdapterOpen()) return false;
  const { mode } = await readEngineeringAgentSwitches(prisma);
  return engineeringAgentAmuxAdapterPermitted({
    codeLatch: ENGINEERING_AGENT_AMUX_ADAPTER_CODE_LATCH,
    executionApiEnabled: isAmuxExecutionApiEnabled(),
    mode,
  });
};

const requireOpen = async () => {
  if (!(await engineeringAgentAmuxAdapterPermittedNow())) throw new EngineeringAgentStoreRefusedError("adapter_closed");
};

/**
 * The catalogue check the AMUX worker routes make before registering or
 * renewing a runtime, made here for the adapter's one worker.
 */
const workerCatalogRefusal = (): "worker_catalog_unavailable" | "worker_not_configured" | null => {
  const catalog = getConfiguredAmuxWorkerCatalog();
  if (!catalog) return "worker_catalog_unavailable";
  return catalog.some((worker) => worker.worker_name === ENGINEERING_AGENT_AMUX_WORKER) ? null : "worker_not_configured";
};

/**
 * Registers a new runtime generation for the adapter's worker, which fences
 * out every earlier generation. The instance id is the runner process's own.
 */
export async function registerEngineeringAgentWorker(input: { instanceId: string; markCommitted?: MarkCommitted }) {
  await requireOpen();
  const refusal = workerCatalogRefusal();
  if (refusal) return { registered: false as const, reason: refusal };
  // A registration creates a generation; a retry of one whose answer was lost
  // must not create another. The request records the generation it created.
  const runtime = await registerAmuxWorkerRuntime(ENGINEERING_AGENT_AMUX_WORKER, input.instanceId, undefined, {
    prismaCalls: WORKER_REGISTER_PRISMA_CALLS,
    work: async (lent, fact) => {
      await input.markCommitted?.(engineeringAgentTransactionInAmux(lent), String(fact.generation));
    },
  });
  return { registered: true as const, generation: runtime.generation, leaseExpiresAt: runtime.leaseExpiresAt };
}

/**
 * Renews the runtime's lease. The worker offers itself for dispatch only
 * while the engineering switches would let it claim, the app holds no halt
 * and both owner queues have room: that is how a card is skipped before it is
 * claimed (§2.1), since a card AMUX assigns to a worker that must then refuse
 * it spends an attempt for nothing.
 */
export async function heartbeatEngineeringAgentWorker(input: {
  lease: EngineeringAgentWorkerLease;
  status: AmuxWorkerRuntimeStatus;
  dispatchReady: boolean;
}) {
  await requireOpen();
  const refusal = workerCatalogRefusal();
  if (refusal) return { accepted: false as const, reason: refusal };
  // An attempt AMUX recovered under a live run is a mismatch for a person
  // (§11); the heartbeat is where the adapter looks for one.
  await runEngineeringAgentTransaction(prisma, (tx) => openEngineeringAgentRunMismatches(tx));
  const switches = await readEngineeringAgentSwitches(prisma);
  const [halt, queues] = await Promise.all([
    readEngineeringAgentHaltState(prisma),
    readEngineeringAgentOwnerQueues(prisma, switches.mode),
  ]);
  const dispatchReady =
    input.dispatchReady && switches.claimAllowed && !engineeringAgentHalted(halt) && queues.claimAllowed;
  const heartbeat = await heartbeatAmuxWorkerRuntime({
    workerName: ENGINEERING_AGENT_AMUX_WORKER,
    instanceId: input.lease.instanceId,
    generation: input.lease.generation,
    status: input.status,
    dispatchReady,
  });
  if (!heartbeat.accepted) return { accepted: false as const, reason: heartbeat.reason ?? "runtime_lease_lost" };
  // The halt, apart from dispatchReady: a service sends no success signal
  // while anything halts, and does after a quiet round that is only off (§12).
  return { accepted: true as const, leaseExpiresAt: heartbeat.leaseExpiresAt, dispatchReady, halt: currentEngineeringAgentHalt(halt) };
}

/**
 * The next durable delivery for the adapter's worker. The runner receives
 * what §2.1 lets it receive -- the card's execution brief, its kind,
 * priority, classification and explicit dependencies -- and nothing else:
 * never the AMUX delivery envelope, which carries the card's title and
 * description. The brief is passed only when it hashes to the digest the
 * promotion stored; otherwise the delivery says why there is none, and the
 * runner ends the run blocked.
 */
export async function pullEngineeringAgentDelivery(input: { lease: EngineeringAgentWorkerLease }) {
  await requireOpen();
  const pulled = await pullAmuxWorkDelivery({
    worker: ENGINEERING_AGENT_AMUX_WORKER,
    instanceId: input.lease.instanceId,
    generation: input.lease.generation,
  });
  if (!pulled.available) return pulled;
  const card = await prisma.amuxWorkItem.findUnique({
    where: { id: pulled.delivery.taskId },
    select: {
      kind: true,
      priority: true,
      classification: true,
      executionBrief: true,
      executionBriefDigest: true,
      dependencies: { select: { dependencyId: true }, orderBy: { dependencyId: "asc" } },
    },
  });
  const brief = card?.executionBrief ?? null;
  const digest = card?.executionBriefDigest ?? null;
  const intact =
    brief !== null && digest !== null && createHash("sha256").update(brief, "utf8").digest("hex") === digest;
  return {
    available: true as const,
    delivery: {
      attemptId: pulled.delivery.attemptId,
      taskId: pulled.delivery.taskId,
      taskRevision: pulled.delivery.taskRevision,
      receiptId: pulled.delivery.receiptId,
      leaseExpiresAt: pulled.delivery.leaseExpiresAt,
      brief: intact ? { text: brief, digest } : null,
      briefIssue: intact ? null : brief === null || digest === null ? ("missing" as const) : ("digest_mismatch" as const),
      kind: card?.kind ?? null,
      priority: card?.priority ?? null,
      classification: card?.classification ?? null,
      dependencies: card?.dependencies.map((dependency) => dependency.dependencyId) ?? [],
    },
  };
}

/** Acknowledges a delivery the runner received, under AMUX's receipt fence. */
export async function acknowledgeEngineeringAgentDelivery(input: {
  lease: EngineeringAgentWorkerLease;
  attemptId: string;
  receiptId: string;
  taskRevision: number;
}) {
  await requireOpen();
  return acknowledgeAmuxWorkDelivery({
    attemptId: input.attemptId,
    receiptId: input.receiptId,
    worker: ENGINEERING_AGENT_AMUX_WORKER,
    instanceId: input.lease.instanceId,
    generation: input.lease.generation,
    taskRevision: input.taskRevision,
  });
}

/**
 * Starts the AMUX attempt for the card AMUX assigned to the adapter's worker
 * -- the earliest-claimed runnable todo it owns, in AMUX's own order -- and
 * creates its run. The runner names no card: AMUX chose it (§2.1).
 * `started: false` is a refusal, AMUX's or `nothing_assigned`, and no run
 * exists.
 */
export async function startEngineeringAgentRun(input: {
  lease: EngineeringAgentWorkerLease;
  baseSha: string;
  markCommitted?: MarkCommitted;
}) {
  await requireOpen();
  const assigned = (await listOwnedTodos()).find((todo) => todo.owner === ENGINEERING_AGENT_AMUX_WORKER);
  if (!assigned) return { started: false as const, reason: "nothing_assigned" as const };
  const runId = mintEngineeringAgentRunId();
  const started = await startAmuxExecution(
    {
      taskId: assigned.id,
      worker: ENGINEERING_AGENT_AMUX_WORKER,
      instanceId: input.lease.instanceId,
      generation: input.lease.generation,
      expectedRevision: assigned.revision,
    },
    engineeringRunStartAttachment({ runId, baseSha: input.baseSha, markCommitted: input.markCommitted }),
  );
  if (!started.started) return started;
  return {
    started: true as const,
    runId,
    taskId: assigned.id,
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
  await requireOpen();
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
  halt: RunnerReportableHalt;
  /** The run's own model spend as the provider reported it, or null when unknown -- never a guessed zero. */
  usageMicrousd: bigint | null;
  markCommitted?: MarkCommitted;
}) {
  await requireOpen();
  const settlement = amuxSettlementForRunOutcome(input.outcome);
  const settled = await settleAmuxExecution(
    {
      attemptId: input.attemptId,
      worker: ENGINEERING_AGENT_AMUX_WORKER,
      instanceId: input.lease.instanceId,
      generation: input.lease.generation,
      taskRevision: input.taskRevision,
      outcome: settlement.outcome,
      toStatus: settlement.toStatus,
      actualCostMicrousd: null,
      // The agent's spend goes to the ledger's agent scope, not the attempt's cost.
      agentUsage: input.usageMicrousd === null ? null : { agentId: "engineering-agent", amountMicrousd: input.usageMicrousd },
    },
    engineeringRunEndAttachment({
      runId: input.runId,
      outcome: input.outcome,
      halt: input.halt,
      markCommitted: input.markCommitted,
    }),
  );
  // The halt as the app now reads it, the run's own included: the runner's
  // dead-man signal follows this, not what it reported (§12).
  return { ...settled, halt: currentEngineeringAgentHalt(await readEngineeringAgentHaltState(prisma)) };
}

/**
 * Records the publisher's result for the item it claimed. A result that
 * published a pull request records that number on the card for its review
 * (the orchestration policy's "review 대상 PR 번호") and settles and binds
 * the item in the same AMUX transaction; any other result touches no AMUX row
 * and settles in an engineering transaction of its own.
 *
 * If AMUX will not take the number -- the card is not waiting on this
 * worker's review -- the pull request still exists: the item is settled and
 * bound all the same, and a state mismatch goes to a person (§11). A fact the
 * publisher reports is never dropped because the other side disagrees. The
 * same holds when the adapter is closed, the mode turned off included: the
 * number then never reaches AMUX, and the mismatch says `adapter_closed`.
 */
export async function recordEngineeringAgentPublisherResult(input: {
  workItemId: string;
  fencingToken: bigint;
  outcome: WriteResultOutcome;
  reason?: string;
  pullRequest: Parameters<typeof recordEngineeringAgentPublishResult>[1]["pullRequest"];
  markCommitted?: MarkCommitted;
}) {
  if (input.pullRequest === null) {
    return runEngineeringAgentTransaction(prisma, async (tx) => {
      const settled = await recordEngineeringAgentPublishResult(tx, { ...input, pullRequest: null });
      await input.markCommitted?.(tx, input.workItemId);
      return { recorded: true as const, ...settled };
    });
  }
  const pullRequest = input.pullRequest;
  const settleWithoutCard = (refusal: string) =>
    runEngineeringAgentTransaction(prisma, async (tx) => {
      const settled = await recordEngineeringAgentPublishResult(tx, { ...input, pullRequest });
      await openEngineeringAgentWorkItem(tx, {
        kind: "state_mismatch",
        causeKey: `review_pr:${input.workItemId}`,
        runId: null,
        reason: refusal,
      });
      await input.markCommitted?.(tx, input.workItemId);
      return { recorded: false as const, reason: refusal, ...settled };
    });
  if (!(await engineeringAgentAmuxAdapterPermittedNow())) return settleWithoutCard("adapter_closed");
  const item = await prisma.engineeringAgentWorkItem.findUnique({
    where: { id: input.workItemId },
    select: { run: { select: { cardId: true, amuxAttemptId: true } } },
  });
  const cardId = item?.run?.cardId ?? null;
  const attemptId = item?.run?.amuxAttemptId ?? null;
  if (cardId === null || attemptId === null) throw new EngineeringAgentStoreRefusedError("publish_item_without_run");
  // The number goes on the review of this item's own attempt, and AMUX takes
  // it only while that attempt is still the card's latest.
  const recorded = await recordAmuxReviewPullRequest(
    { taskId: cardId, attemptId, worker: ENGINEERING_AGENT_AMUX_WORKER, prNumber: pullRequest.prNumber },
    engineeringPublishResultAttachment({
      workItemId: input.workItemId,
      fencingToken: input.fencingToken,
      outcome: input.outcome,
      pullRequest,
      markCommitted: input.markCommitted,
    }),
  );
  if (recorded.recorded) return recorded;
  return settleWithoutCard(recorded.reason);
}
