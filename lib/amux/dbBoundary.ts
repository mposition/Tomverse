import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";
import { prisma, prismaPoolUsage, type PrismaPoolUsage } from "@/lib/prisma";
import {
  AMUX_COMMIT_DEADLINE_TRIGGER,
  isAmuxLateCommitError,
} from "@/lib/amux/commitDeadlineCore";
import {
  amuxTransactionNotStartedCode,
  amuxTransientDatabaseCode,
  isAmuxDbBusyCode,
} from "@/lib/amux/readFailureCore";
import type {
  AmuxOrchestratorCallKind,
  AmuxOrchestratorReceiptTargetKind,
} from "@/lib/amux/orchestratorHaltCore";
import {
  amuxOrchestratorReceiptInsertSql,
  insertAmuxOrchestratorAdmission,
  lockAmuxOrchestratorAdmission,
  type AmuxOrchestratorReceipt,
} from "@/lib/amux/orchestratorHaltStore";

export const AMUX_DB_STATEMENT_TIMEOUT_MS = 200;
export const AMUX_DB_IDLE_TRANSACTION_TIMEOUT_MS = 100;
export const AMUX_DB_COMMIT_RESERVE_MS = 200;
/**
 * The longest a transaction waits for a pool connection and its BEGIN
 * (Prisma's `maxWait`). Inside a route it is further capped by
 * `amuxDbConnectionWaitMs`: a transaction waits only out of the time its route
 * has left beyond the transaction's own budget, so a longer wait never makes a
 * route answer later than its budget. 250 ms (until 2026-09-30) failed most
 * orchestrator runs against a 10-connection pool shared with web traffic.
 */
export const AMUX_DB_MAX_WAIT_MS = 2_000;
/** Prisma's interactive-transaction timeout is the budget plus this. */
export const AMUX_DB_TRANSACTION_TIMEOUT_SLACK_MS = 300;
// This is an application-level Prisma API-call ceiling, not a PostgreSQL
// statement counter. A single Prisma call can emit more than one SQL statement.
// PostgreSQL enforces the statement and idle-in-transaction timeouts below,
// but the derived transaction budget is an application estimate. This code
// does not set transaction_timeout: PostgreSQL 17 could bound occupancy only
// from an in-transaction SET (not BEGIN-to-SET or durable COMMIT); PostgreSQL
// 16 lacks that setting. Neither a SQL statement-count cap nor a
// whole-transaction time bound is itself required.
//
// What the database does enforce (policy version 18) is that a mutation
// transaction with a deadline does not COMMIT after it: its fence inserts an
// `AmuxCommitDeadline` row, and a deferred constraint trigger fails the COMMIT
// with SQLSTATE AX001 once the database clock has reached the same deadline
// the fence used (lib/amux/commitDeadlineCore.ts). What stays outside it is
// the commit record's own write and flush after that check, which the commit
// reserve exists to cover, and the time before the first statement.
export const AMUX_ROUTE_BUDGET_MS = 15_000;
// Single-operation future lifecycle routes have a shared DB-clock deadline.
// The Rust client allows fifteen seconds for connect, route and response
// transport, leaving a three-second margin around the server budget.
export const AMUX_LIFECYCLE_ROUTE_BUDGET_MS = 12_000;

export type AmuxDbBoundary = {
  operation: string;
  prismaCallCeiling: number;
  isolation: "read" | "mutation";
  /**
   * `none` for a mutation that only records a refusal audit and changes no
   * state (orchestration policy version 20, section 4): inside an admitted
   * orchestrator write it neither locks the admission nor writes a receipt.
   * Every other mutation of an admitted write locks the admission row before
   * its work, which costs it `AMUX_ORCHESTRATOR_ADMISSION_LOCK_CALLS` more.
   */
  admissionLock?: "none";
};

/**
 * The one extra Prisma call a mutation of an admitted orchestrator write makes:
 * its admission row lock (lib/amux/orchestratorHaltStore.ts). Its receipts ride
 * in the commit fence and cost nothing more. Only such a mutation is widened,
 * so a route called without a request id is budgeted exactly as before.
 */
export const AMUX_ORCHESTRATOR_ADMISSION_LOCK_CALLS = 1;

/**
 * The admission transaction's own budget: a statement timeout setting and one
 * insert, each at most a statement and an idle timeout, and the commit reserve.
 */
export const AMUX_ORCHESTRATOR_ADMISSION_BUDGET_MS = 800;

export const AMUX_DB_BOUNDARIES = {
  claimRouteClock: {
    operation: "claim_route_clock",
    prismaCallCeiling: 2,
    isolation: "read",
  },
  queueRead: {
    operation: "queue_read",
    prismaCallCeiling: 6,
    isolation: "read",
  },
  // 7: the busy-owner read (one open card per worker) joined the snapshot.
  routingSnapshot: {
    operation: "routing_snapshot",
    prismaCallCeiling: 7,
    isolation: "read",
  },
  routingTaskRead: {
    operation: "routing_task_read",
    prismaCallCeiling: 5,
    isolation: "read",
  },
  workerCatalogRead: {
    operation: "worker_catalog_read",
    prismaCallCeiling: 3,
    isolation: "read",
  },
  workerRegister: {
    operation: "worker_register",
    prismaCallCeiling: 7,
    isolation: "mutation",
  },
  workerHeartbeat: {
    operation: "worker_heartbeat",
    prismaCallCeiling: 9,
    isolation: "mutation",
  },
  // 18: the one-open-card-per-worker count added a read to the success path.
  claim: { operation: "claim", prismaCallCeiling: 18, isolation: "mutation" },
  // A refusal audit changes no ownership or status, so an admitted claim's
  // refusal takes no admission lock and leaves no receipt (policy version 20).
  claimRefusal: {
    operation: "claim_refusal",
    prismaCallCeiling: 6,
    isolation: "mutation",
    admissionLock: "none",
  },
  ownedQueueRead: {
    operation: "owned_queue_read",
    prismaCallCeiling: 3,
    isolation: "read",
  },
  deliveryPull: {
    operation: "delivery_pull",
    // setup + runtime fence + candidate + update + canonical audit + fence
    prismaCallCeiling: 9,
    isolation: "mutation",
  },
  deliveryKeyRead: {
    operation: "delivery_key_read",
    // setup + queued delivery + source metadata + read fence
    prismaCallCeiling: 4,
    isolation: "read",
  },
  deliveryAck: {
    operation: "delivery_ack",
    prismaCallCeiling: 11,
    isolation: "mutation",
  },
  executionStart: {
    operation: "execution_start",
    prismaCallCeiling: 30,
    isolation: "mutation",
  },
  executionHeartbeat: {
    operation: "execution_heartbeat",
    // setup + three fenced reads + update + four canonical-audit calls + fence
    prismaCallCeiling: 10,
    isolation: "mutation",
  },
  executionSettle: {
    operation: "execution_settle",
    prismaCallCeiling: 26,
    isolation: "mutation",
  },
  executionRecoveryRead: {
    operation: "execution_recovery_read",
    prismaCallCeiling: 4,
    isolation: "read",
  },
  executionRecoveryWrite: {
    operation: "execution_recovery_write",
    prismaCallCeiling: 21,
    isolation: "mutation",
  },
  quotaObservationSweep: {
    operation: "quota_observation_sweep",
    // setup + one bounded CTE DELETE + commit fence
    prismaCallCeiling: 3,
    isolation: "mutation",
  },
  ownershipRecoveryRead: {
    operation: "ownership_recovery_read",
    prismaCallCeiling: 4,
    isolation: "read",
  },
  ownershipRecoveryWrite: {
    operation: "ownership_recovery_write",
    prismaCallCeiling: 9,
    isolation: "mutation",
  },
  agentIntake: {
    operation: "agent_intake",
    // setup + source lock + existing card + card insert + canonical audit + fence
    prismaCallCeiling: 10,
    isolation: "mutation",
  },
  reviewPullRequest: {
    operation: "review_pull_request",
    // setup + task lock + latest attempt + update + canonical audit + fence
    prismaCallCeiling: 10,
    isolation: "mutation",
  },
  // Policy version 20. setup + admission lock + receipt count + ackedAt + fence
  orchestratorAck: {
    operation: "orchestrator_ack",
    prismaCallCeiling: 5,
    isolation: "mutation",
  },
  // setup + candidate list + fence
  orchestratorResolveCandidates: {
    operation: "orchestrator_resolve_candidates",
    prismaCallCeiling: 3,
    isolation: "read",
  },
  // setup + admission lock + receipt count + system audit (4) + update + fence
  orchestratorResolve: {
    operation: "orchestrator_resolve",
    prismaCallCeiling: 9,
    isolation: "mutation",
  },
  // setup + open halts + counts + people's list + requested keys + fence
  orchestratorHaltStateRead: {
    operation: "orchestrator_halt_state_read",
    prismaCallCeiling: 6,
    isolation: "read",
  },
  // setup + key lock + existing + admission call kind + system audit (4) +
  // insert + fence
  orchestratorHaltOpen: {
    operation: "orchestrator_halt_open",
    prismaCallCeiling: 10,
    isolation: "mutation",
  },
  // Decision Maker switches (docs/policy/amux-decision-maker.md §8): setup +
  // the newest event of every scope + fence.
  decisionMakerSwitchRead: {
    operation: "decision_maker_switch_read",
    prismaCallCeiling: 3,
    isolation: "read",
  },
  // setup + a person's change at its largest (audit chain lock, the scope's
  // newest event, the administrator audit's 4 with an integrity key, the
  // event insert: 7, pinned by tests/amuxDecisionMakerSwitch.test.mjs) + fence
  decisionMakerSwitchChange: {
    operation: "decision_maker_switch_change",
    prismaCallCeiling: 9,
    isolation: "mutation",
  },
} as const satisfies Record<string, AmuxDbBoundary>;

/**
 * - `AMUX_DB_DEADLINE_EXCEEDED`: refused before COMMIT, or at COMMIT by the
 *   commit deadline trigger (SQLSTATE AX001). Rolled back either way.
 * - `AMUX_DB_PRISMA_CALL_CEILING_EXCEEDED`: refused before the call. Rolled back.
 * - `AMUX_DB_COMMIT_CHECK_MISSING`: the fence found no commit deadline trigger
 *   that will fire, so it refused rather than commit without the check. Rolled
 *   back.
 * - `AMUX_DB_OUTCOME_UNKNOWN`: a mutation transaction failed after its callback
 *   returned, for any reason but AX001. The COMMIT may or may not have taken
 *   effect; the caller reads back and never retries blindly.
 * - `AMUX_DB_READ_BUSY`: a read transaction failed because the database could
 *   not take it just then (lib/amux/readFailureCore.ts), inside a route that
 *   had not started a mutation. Nothing was written; the caller may ask again.
 * - `AMUX_DB_NOT_STARTED`: a transaction, read or mutation, could not get its
 *   connection or start within its connection wait (P2024/P2028 before its
 *   callback ran), inside a route that had not started a mutation. None of its
 *   SQL ran, so nothing was written; the caller may ask again. An orchestrator
 *   write whose admission could not be committed is reported the same way
 *   (policy version 20, section 4): the write did not start.
 * - `AMUX_DB_ADMISSION_CLOSED`: a state-changing transaction of an admitted
 *   orchestrator write found its admission row missing, acknowledged or
 *   resolved under the row lock, and rolled back before changing anything
 *   (section 4). The request is answered as an unknown outcome, never as one
 *   of the three answers that say nothing was committed.
 */
export type AmuxDbBoundaryErrorCode =
  | "AMUX_DB_DEADLINE_EXCEEDED"
  | "AMUX_DB_PRISMA_CALL_CEILING_EXCEEDED"
  | "AMUX_DB_COMMIT_CHECK_MISSING"
  | "AMUX_DB_OUTCOME_UNKNOWN"
  | "AMUX_DB_READ_BUSY"
  | "AMUX_DB_NOT_STARTED"
  | "AMUX_DB_ADMISSION_CLOSED";

/** The two codes answered 503 `amux_database_busy`: nothing was written. */
export const isAmuxDbBusyError = (
  error: unknown,
): error is AmuxDbBoundaryError =>
  error instanceof AmuxDbBoundaryError && isAmuxDbBusyCode(error.code);

export class AmuxDbBoundaryError extends Error {
  readonly code: AmuxDbBoundaryErrorCode;
  /**
   * Diagnostics on a busy failure only, for the operator's log line: the
   * connection wait this transaction was given and the pool's connection
   * counts when it failed. Never a connection string.
   */
  connectionWaitMs?: number;
  poolUsage?: PrismaPoolUsage | null;

  constructor(
    code: AmuxDbBoundaryErrorCode,
    operation: string,
    options?: { cause?: unknown },
  ) {
    super(`${code}:${operation}`, options);
    this.name = "AmuxDbBoundaryError";
    this.code = code;
  }
}

type AmuxRouteDeadline = {
  localDeadlineMs: number;
  maxMs: number;
  databaseDeadlineAt?: Date;
  /**
   * Set when the first transaction of this route that can write has started:
   * a mutation boundary's callback began, or a transaction anchored the route
   * deadline itself (`anchorAmuxRouteDeadline`). Once set, a later failure of
   * the route can no longer say that nothing was written. A mutation that
   * never got its connection does not set it: none of its SQL ran.
   */
  mutationStarted: boolean;
  /**
   * Set by `admitAmuxOrchestratorWrite` once the route's admission has
   * committed (orchestration policy version 20, section 4). Every
   * state-changing transaction of the route then locks that row and writes
   * its receipts in its fence. `receiptCommits` counts the transactions whose
   * receipts reached COMMIT and were not refused by the database (SQLSTATE
   * AX001): after the first, the route never answers one of the three 503
   * reasons that say nothing was committed.
   */
  orchestratorWrite?: { requestId: string; receiptCommits: number };
};
const amuxRouteDeadline = new AsyncLocalStorage<AmuxRouteDeadline>();

/**
 * Section 1: whether a receipt of this route's admitted request may have
 * committed. The internal route reads it before answering 503
 * `amux_database_busy`, `amux_database_deadline_exceeded` or
 * `amux_database_call_ceiling_exceeded`, and answers `amux_outcome_unknown`
 * instead when it is true.
 */
export const amuxRouteOrchestratorReceiptsMayHaveCommitted = (): boolean =>
  (amuxRouteDeadline.getStore()?.orchestratorWrite?.receiptCommits ?? 0) > 0;

/**
 * Records that a transaction carrying receipts of the route's admitted request
 * is about to COMMIT. Returns the undo for the one failure that proves the
 * COMMIT did not happen, the commit deadline trigger's AX001; every other
 * COMMIT failure leaves the mark, because the receipts may have committed.
 * Outside an admitted route it records nothing.
 */
export const markAmuxRouteOrchestratorReceiptsCommitting = (): (() => void) => {
  const orchestratorWrite = amuxRouteDeadline.getStore()?.orchestratorWrite;
  if (!orchestratorWrite) return () => {};
  orchestratorWrite.receiptCommits += 1;
  let undone = false;
  return () => {
    if (undone) return;
    undone = true;
    orchestratorWrite.receiptCommits -= 1;
  };
};

/** The admitted request id of this route, or null. */
export const amuxRouteOrchestratorRequestId = (): string | null =>
  amuxRouteDeadline.getStore()?.orchestratorWrite?.requestId ?? null;

/**
 * Section 4: locks the admission row of this route's admitted request, for a
 * transaction that is about to change state, and refuses before any change
 * when the row is missing, acknowledged or resolved. Returns false outside an
 * admitted route, where nothing is locked.
 */
export async function lockAmuxRouteOrchestratorAdmission(
  tx: Prisma.TransactionClient,
  operation: string,
): Promise<boolean> {
  const requestId = amuxRouteOrchestratorRequestId();
  if (requestId === null) return false;
  const admission = await lockAmuxOrchestratorAdmission(tx, requestId);
  if (!admission || admission.acked || admission.resolved) {
    console.warn(
      JSON.stringify({
        subsystem: "amux",
        event: "orchestrator_admission_closed",
        operation,
        admission: admission === null ? "missing" : admission.resolved ? "resolved" : "acked",
      }),
    );
    throw new AmuxDbBoundaryError("AMUX_DB_ADMISSION_CLOSED", operation);
  }
  return true;
}

/**
 * Section 4: the admission of one orchestrator write, as the first transaction
 * of its route, committed on its own before the route does anything else. The
 * route's database deadline is anchored on the admission's `deadlineAt` -- the
 * admission clock plus this route's budget -- so every later commit fence of
 * the route is held to a deadline no later than the one the resolver waits
 * out. A second admission of the same request id is refused (`admitted:
 * false`). An admission that cannot be committed, for any reason, is reported
 * as a transaction that did not start: the route answers 503
 * `amux_database_busy` and starts no write.
 */
export async function admitAmuxOrchestratorWrite(input: {
  requestId: string;
  instanceId: string;
  callKind: AmuxOrchestratorCallKind;
}): Promise<{ admitted: boolean }> {
  const routeDeadline = amuxRouteDeadline.getStore();
  if (
    !routeDeadline ||
    routeDeadline.databaseDeadlineAt !== undefined ||
    routeDeadline.mutationStarted ||
    routeDeadline.orchestratorWrite !== undefined
  ) {
    throw new Error("An orchestrator admission must be its route's first transaction");
  }
  const routeRemainingMs = routeDeadline.localDeadlineMs - Date.now();
  let admitted: Awaited<ReturnType<typeof insertAmuxOrchestratorAdmission>>;
  try {
    if (routeRemainingMs < AMUX_ORCHESTRATOR_ADMISSION_BUDGET_MS) {
      throw new Error("route budget exhausted before admission");
    }
    admitted = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(AMUX_DB_STATEMENT_TIMEOUT_MS)}, true)`;
        return insertAmuxOrchestratorAdmission(tx, {
          requestId: input.requestId,
          instanceId: input.instanceId,
          callKind: input.callKind,
          budgetMs: routeDeadline.maxMs,
        });
      },
      {
        maxWait: amuxDbConnectionWaitMs(
          routeRemainingMs,
          AMUX_ORCHESTRATOR_ADMISSION_BUDGET_MS,
        ),
        timeout: AMUX_ORCHESTRATOR_ADMISSION_BUDGET_MS,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      },
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        subsystem: "amux",
        event: "orchestrator_admission_failed",
        call_kind: input.callKind,
        error_code:
          amuxTransactionNotStartedCode(error) ?? amuxTransientDatabaseCode(error) ?? "other",
      }),
    );
    throw new AmuxDbBoundaryError("AMUX_DB_NOT_STARTED", "orchestrator_admission", {
      cause: error,
    });
  }
  if (!admitted.admitted) return { admitted: false };
  routeDeadline.databaseDeadlineAt = admitted.deadlineAt;
  routeDeadline.orchestratorWrite = { requestId: input.requestId, receiptCommits: 0 };
  return { admitted: true };
}

export type { AmuxOrchestratorReceipt };

/** Records one receipt of the transaction it is given to. */
export type AmuxOrchestratorReceiptRecorder = (
  targetKind: AmuxOrchestratorReceiptTargetKind,
  targetId: string | null,
  rowCount: number,
) => void;

/**
 * What the route had done when one of its transactions failed.
 *
 * - `outside_route`: no `withAmuxRouteBudget` scope, so nothing is known about
 *   earlier writes of the caller (an in-app adapter, a script).
 * - `no_mutation_started`: inside a route that has not started a transaction
 *   that can write.
 * - `mutation_started`: inside a route that has.
 */
export type AmuxRouteWriteState =
  | "outside_route"
  | "no_mutation_started"
  | "mutation_started";

const amuxRouteWriteState = (
  routeDeadline: AmuxRouteDeadline | undefined,
): AmuxRouteWriteState =>
  routeDeadline === undefined
    ? "outside_route"
    : routeDeadline.mutationStarted
      ? "mutation_started"
      : "no_mutation_started";

export const amuxDbTransactionBudgetMs = (boundary: AmuxDbBoundary) =>
  boundary.prismaCallCeiling * AMUX_DB_STATEMENT_TIMEOUT_MS +
  boundary.prismaCallCeiling * AMUX_DB_IDLE_TRANSACTION_TIMEOUT_MS +
  AMUX_DB_COMMIT_RESERVE_MS;

/**
 * Prisma's `maxWait` for one transaction.
 *
 * Outside a route it is `AMUX_DB_MAX_WAIT_MS`. Inside one it is also capped by
 * what the route has left beyond this transaction's budget, so the
 * transaction, if it starts at all, starts no later than its route's deadline
 * less its budget: the wait comes out of the route's slack and never extends
 * the route. The route budgets and the Rust client deadlines sized on them
 * therefore hold whatever this maximum is. At least 1 ms (Prisma refuses 0);
 * the coarse admission has already refused a transaction without its budget.
 */
export const amuxDbConnectionWaitMs = (
  routeRemainingMs: number | null,
  transactionBudgetMs: number,
): number =>
  routeRemainingMs === null
    ? AMUX_DB_MAX_WAIT_MS
    : Math.max(
        1,
        Math.min(
          AMUX_DB_MAX_WAIT_MS,
          Math.floor(routeRemainingMs - transactionBudgetMs),
        ),
      );

/**
 * Coarse admission for a transaction whose application per-transaction
 * maximum is `transactionMaxMs`. Outside `withAmuxRouteBudget` there is no
 * route deadline and nothing to refuse.
 */
export const amuxRouteHasBudgetForMs = (transactionMaxMs: number): boolean => {
  const deadline = amuxRouteDeadline.getStore();
  if (!deadline) return true;
  // Coarse admission only. The authoritative cross-transaction limit is
  // checked against the PostgreSQL clock in each transaction setup/fence.
  return deadline.localDeadlineMs - Date.now() >= transactionMaxMs;
};

export const amuxRouteHasBudgetFor = (boundary: AmuxDbBoundary): boolean =>
  amuxRouteHasBudgetForMs(amuxDbTransactionBudgetMs(boundary));

/**
 * The route deadline for a transaction that is not a `withAmuxDbBoundary`
 * one: it keeps its own statement timeout and Prisma limits (the
 * auto-promotion transactions are such), and declares its own application
 * per-transaction maximum. Inside `withAmuxRouteBudget` it meets the same two
 * database-clock checks as a bounded transaction.
 *
 * `anchorAmuxRouteDeadline` runs first in the transaction. It anchors the
 * route's database deadline on the first transaction of the route, as
 * `withAmuxDbBoundary` does, and refuses when less than `transactionMaxMs`
 * is left. It returns the deadline, or null outside a route budget.
 *
 * `fenceAmuxRouteDeadline` runs last, just before COMMIT. Like the bounded
 * mutation fence it records the commit deadline — the route deadline less
 * `AMUX_DB_COMMIT_RESERVE_MS` — for the COMMIT-time trigger, and refuses once
 * the database clock has reached that same deadline, so the transaction rolls
 * back instead of committing late. A COMMIT that then arrives after it fails
 * with SQLSTATE AX001.
 */
export async function anchorAmuxRouteDeadline(
  tx: Prisma.TransactionClient,
  transactionMaxMs: number,
  operation: string,
): Promise<Date | null> {
  const routeDeadline = amuxRouteDeadline.getStore();
  if (!routeDeadline) return null;
  // This transaction records a commit deadline, so it can write: a read of
  // the same route that fails after this point cannot say nothing was written.
  routeDeadline.mutationStarted = true;
  const rows = await tx.$queryRaw<Array<{ dbNowEpochMs: bigint }>>`
    SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "dbNowEpochMs"
  `;
  const raw: unknown = rows[0]?.dbNowEpochMs;
  const dbNowEpochMs =
    typeof raw === "bigint" || typeof raw === "number" ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(dbNowEpochMs)) {
    throw new AmuxDbBoundaryError("AMUX_DB_DEADLINE_EXCEEDED", operation);
  }
  routeDeadline.databaseDeadlineAt ??= new Date(
    dbNowEpochMs + routeDeadline.maxMs,
  );
  if (
    routeDeadline.databaseDeadlineAt.getTime() - dbNowEpochMs <
    transactionMaxMs
  ) {
    throw new AmuxDbBoundaryError("AMUX_DB_DEADLINE_EXCEEDED", operation);
  }
  return routeDeadline.databaseDeadlineAt;
}

export async function fenceAmuxRouteDeadline(
  tx: Prisma.TransactionClient,
  deadlineAt: Date | null,
  operation: string,
  receipts: readonly AmuxOrchestratorReceipt[] = [],
): Promise<void> {
  const requestId = amuxRouteOrchestratorRequestId();
  if (deadlineAt === null) {
    // Outside a route there is no admitted request, so there is nothing to
    // record a receipt against.
    if (requestId !== null && receipts.length > 0) {
      throw new Error("An admitted orchestrator write has no route deadline");
    }
    return;
  }
  if (requestId !== null && receipts.length > 0) {
    await fenceAmuxRouteDeadlineWithReceipts(tx, deadlineAt, operation, requestId, receipts);
    return;
  }
  // One statement: record the commit deadline for the COMMIT-time trigger,
  // confirm that trigger will fire, and compare the clock with the same
  // deadline. See `withAmuxDbBoundary` for why each clause is written so.
  const fence = await tx.$queryRaw<AmuxCommitFenceRow[]>`
    WITH commit_deadline AS MATERIALIZED (
      SELECT date_trunc(
        'milliseconds',
        ${deadlineAt.toISOString()}::timestamptz -
          ${AMUX_DB_COMMIT_RESERVE_MS} * INTERVAL '1 millisecond'
      ) AS "deadline"
    ), marker AS (
      INSERT INTO "AmuxCommitDeadline" ("txid", "deadline", "operation")
      SELECT txid_current(), "deadline", ${operation}
      FROM commit_deadline
      RETURNING "deadline"
    ), commit_check AS MATERIALIZED (
      SELECT (
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          WHERE c.oid = to_regclass('"AmuxCommitDeadline"')
            AND t.tgname = ${AMUX_COMMIT_DEADLINE_TRIGGER}
            AND t.tgdeferrable
            AND t.tginitdeferred
            AND t.tgenabled = 'O'
            AND (t.tgtype::integer & 4) <> 0
        )
        AND current_setting('session_replication_role') <> 'replica'
      ) AS "installed"
    )
    SELECT
      clock_timestamp() < marker."deadline" AS "withinDeadline",
      commit_check."installed" AS "commitCheckInstalled"
    FROM marker CROSS JOIN commit_check
  `;
  requireAmuxCommitFence(fence, operation);
}

/**
 * The same fence with the receipts of an admitted orchestrator write (policy
 * version 20, section 4) as one more data-modifying CTE of the same statement,
 * so they commit exactly when the rest of the transaction does. A separate
 * text rather than an empty fragment in the one above, so a transaction
 * without receipts sends exactly the statement it sent before.
 */
async function fenceAmuxRouteDeadlineWithReceipts(
  tx: Prisma.TransactionClient,
  deadlineAt: Date,
  operation: string,
  requestId: string,
  receipts: readonly AmuxOrchestratorReceipt[],
): Promise<void> {
  const receiptSql = amuxOrchestratorReceiptInsertSql(requestId, receipts);
  const fence = await tx.$queryRaw<AmuxCommitFenceRow[]>`
    WITH commit_deadline AS MATERIALIZED (
      SELECT date_trunc(
        'milliseconds',
        ${deadlineAt.toISOString()}::timestamptz -
          ${AMUX_DB_COMMIT_RESERVE_MS} * INTERVAL '1 millisecond'
      ) AS "deadline"
    ), marker AS (
      INSERT INTO "AmuxCommitDeadline" ("txid", "deadline", "operation")
      SELECT txid_current(), "deadline", ${operation}
      FROM commit_deadline
      RETURNING "deadline"
    ), commit_check AS MATERIALIZED (
      SELECT (
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          WHERE c.oid = to_regclass('"AmuxCommitDeadline"')
            AND t.tgname = ${AMUX_COMMIT_DEADLINE_TRIGGER}
            AND t.tgdeferrable
            AND t.tginitdeferred
            AND t.tgenabled = 'O'
            AND (t.tgtype::integer & 4) <> 0
        )
        AND current_setting('session_replication_role') <> 'replica'
      ) AS "installed"
    )${receiptSql}
    SELECT
      clock_timestamp() < marker."deadline" AS "withinDeadline",
      commit_check."installed" AS "commitCheckInstalled"
    FROM marker CROSS JOIN commit_check
  `;
  requireAmuxCommitFence(fence, operation);
}

type AmuxCommitFenceRow = {
  withinDeadline: boolean | null;
  commitCheckInstalled: boolean | null;
};

/**
 * The verdict of a commit fence. A missing trigger is checked first: without
 * it nothing would look at the deadline at COMMIT, so the transaction is
 * refused, never committed without the check, and the refusal is logged.
 */
const requireAmuxCommitFence = (
  rows: AmuxCommitFenceRow[],
  operation: string,
): void => {
  const row = rows[0];
  if (row?.commitCheckInstalled !== true) {
    console.warn(
      JSON.stringify({
        subsystem: "amux",
        event: "commit_deadline_check_missing",
        operation,
      }),
    );
    throw new AmuxDbBoundaryError("AMUX_DB_COMMIT_CHECK_MISSING", operation);
  }
  if (row.withinDeadline !== true) {
    throw new AmuxDbBoundaryError("AMUX_DB_DEADLINE_EXCEEDED", operation);
  }
};

/**
 * Where a bounded transaction was when it failed.
 *
 * - `starting`: its callback has not begun. Prisma was still getting a pool
 *   connection and sending BEGIN within `maxWait`; a transaction that starts
 *   late is rolled back by Prisma without running the callback. None of the
 *   boundary's SQL has run.
 * - `running`: the callback began and has not returned.
 * - `committing`: the callback returned; only the COMMIT is left.
 */
export type AmuxDbBoundaryPhase = "starting" | "running" | "committing";

/**
 * What a failed bounded transaction is reported as.
 *
 * | phase      | isolation | error                         | route wrote before | reported as              |
 * |------------|-----------|-------------------------------|--------------------|--------------------------|
 * | any        | any       | AX001                         | any                | AMUX_DB_DEADLINE_EXCEEDED |
 * | committing | mutation  | anything else                 | any                | AMUX_DB_OUTCOME_UNKNOWN  |
 * | starting   | any       | P2024, P2028                  | no                 | AMUX_DB_NOT_STARTED      |
 * | any        | read      | transient (readFailureCore)   | no                 | AMUX_DB_READ_BUSY        |
 * | otherwise  |           |                               |                    | the error, unchanged     |
 *
 * "Route wrote before" is `mutation_started`; outside a route it counts as yes,
 * because nothing is known about what the caller did before.
 *
 * SQLSTATE AX001 is read first, before the phase: it arrives while committing,
 * but it is the commit deadline trigger's refusal and PostgreSQL has rolled the
 * transaction back, so it is a known deadline refusal.
 *
 * Any other failure of a mutation transaction after its callback returned is
 * an unknown outcome, a statement timeout (57014) included: a cancel that
 * lands while the commit record is being flushed can reach the client after
 * the commit is durable, so it is not proof of a rollback. Only a 57014 raised
 * while the callback was running stays a known rollback, and it is passed on
 * unchanged, as is every failure before COMMIT.
 *
 * A read transaction records nothing, so it never has an unknown outcome. The
 * one thing decided for a read is whether the database was merely busy -- a
 * pool, transaction-start, statement-timeout or connection failure
 * (lib/amux/readFailureCore.ts) -- and that is reported as
 * `AMUX_DB_READ_BUSY` only when the route it ran in had not started a
 * transaction that can write: then nothing at all was written and the caller
 * may ask again. After such a transaction, or outside a route, and for every
 * other read failure, the error is passed on unchanged, and so answered as it
 * was before. This is the only place the read/mutation decision is made; it
 * reads the boundary's `isolation`, never the route's name.
 *
 * A transaction that never started wrote nothing either, mutation or not: a
 * P2024 or P2028 while `starting` is the pool or `maxWait` refusing it before
 * its callback ran. The same P2028 once the callback has begun is the
 * interactive transaction's own timeout, and keeps its old answer: passed on
 * while running (a known rollback, still answered as an unknown outcome by the
 * internal route) and an unknown outcome while committing.
 */
export const amuxDbBoundaryFailure = (
  boundary: AmuxDbBoundary,
  phase: AmuxDbBoundaryPhase,
  error: unknown,
  routeWrites: AmuxRouteWriteState,
): unknown => {
  if (isAmuxLateCommitError(error)) {
    return new AmuxDbBoundaryError(
      "AMUX_DB_DEADLINE_EXCEEDED",
      boundary.operation,
      { cause: error },
    );
  }
  if (phase === "committing" && boundary.isolation === "mutation") {
    return new AmuxDbBoundaryError(
      "AMUX_DB_OUTCOME_UNKNOWN",
      boundary.operation,
      { cause: error },
    );
  }
  if (
    routeWrites !== "no_mutation_started" ||
    error instanceof AmuxDbBoundaryError
  ) {
    return error;
  }
  if (phase === "starting" && amuxTransactionNotStartedCode(error) !== null) {
    return new AmuxDbBoundaryError("AMUX_DB_NOT_STARTED", boundary.operation, {
      cause: error,
    });
  }
  if (
    boundary.isolation === "read" &&
    amuxTransientDatabaseCode(error) !== null
  ) {
    return new AmuxDbBoundaryError("AMUX_DB_READ_BUSY", boundary.operation, {
      cause: error,
    });
  }
  return error;
};

const safePoolUsage = (): PrismaPoolUsage | null => {
  try {
    return prismaPoolUsage();
  } catch {
    return null;
  }
};

export const withAmuxRouteBudget = <T>(
  work: () => Promise<T>,
  maxMs = AMUX_ROUTE_BUDGET_MS,
): Promise<T> =>
  amuxRouteDeadline.run(
    { localDeadlineMs: Date.now() + maxMs, maxMs, mutationStarted: false },
    work,
  );

const PRISMA_MODEL_CALL_METHODS = new Set([
  "aggregate",
  "count",
  "create",
  "createMany",
  "createManyAndReturn",
  "delete",
  "deleteMany",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);
const PRISMA_RAW_CALL_METHODS = new Set([
  "executeRaw",
  "executeRawUnsafe",
  "queryRaw",
  "queryRawUnsafe",
]);

const boundedTransactionClient = (
  tx: Prisma.TransactionClient,
  boundary: AmuxDbBoundary,
  initialPrismaCalls: number,
): Prisma.TransactionClient => {
  let prismaCallCount = initialPrismaCalls;
  const proxies = new WeakMap<object, object>();

  const wrap = (value: unknown): unknown => {
    if (
      (typeof value !== "object" && typeof value !== "function") ||
      value === null
    ) {
      return value;
    }

    const objectValue = value as object;
    const existing = proxies.get(objectValue);
    if (existing) return existing;

    const proxy = new Proxy(objectValue, {
      get(target, property, receiver) {
        const member = Reflect.get(target, property, receiver);

        if (
          typeof property === "string" &&
          typeof member === "function" &&
          (PRISMA_MODEL_CALL_METHODS.has(property) ||
            (property.startsWith("$") &&
              PRISMA_RAW_CALL_METHODS.has(property.slice(1))))
        ) {
          return (...args: unknown[]) => {
            prismaCallCount += 1;
            if (prismaCallCount > boundary.prismaCallCeiling) {
              throw new AmuxDbBoundaryError(
                "AMUX_DB_PRISMA_CALL_CEILING_EXCEEDED",
                boundary.operation,
              );
            }
            return Reflect.apply(member, target, args);
          };
        }

        return wrap(member);
      },
    });

    proxies.set(objectValue, proxy);
    return proxy;
  };

  return wrap(tx) as Prisma.TransactionClient;
};

declare const AMUX_ATTACHED_TRANSACTION_BRAND: unique symbol;

/**
 * An AMUX writer's own open transaction, lent to an in-app adapter that an
 * Agent policy approved (development-agent-orchestration.md, Authority,
 * version 12). Only `withAmuxDbBoundary` produces one, so a value of this type
 * is always the bounded transaction client and never a whole PrismaClient.
 */
export type AmuxAttachedTransaction = Prisma.TransactionClient & {
  readonly [AMUX_ATTACHED_TRANSACTION_BRAND]: "amux-attached";
};

/**
 * Work an adapter attaches to one AMUX writer call. The writer runs it only
 * on the path where its own write succeeded, after every AMUX row it locks
 * and before the commit fence, so the adapter's rows come after AMUX's in the
 * lock order. A throw rolls the AMUX write back with it: the two are one fact
 * or neither happened. The attached calls go through the same bounded client
 * and count against the writer's ceiling, which `prismaCalls` widens.
 *
 * `beforeWrite`, where a writer offers it, runs after the writer's row locks
 * and before its first write, including a write on a refusal path (execution
 * start blocks a card whose cost or attempt budget refuses it). A throw there
 * refuses the call with nothing written, which is how an adapter says no
 * before AMUX records anything.
 */
export type AmuxAttachment<R> = {
  prismaCalls: number;
  beforeWrite?: (tx: AmuxAttachedTransaction, context: { taskId: string }) => Promise<void>;
  work: (
    tx: AmuxAttachedTransaction,
    result: R,
    context: { dbNow: Date },
  ) => Promise<void>;
};

/** Enough for an adapter's own checks, row and audit entry, and no more. */
export const AMUX_ATTACHMENT_MAX_PRISMA_CALLS = 24;

/** The writer's boundary, widened by exactly what its attachment declared. */
export const amuxBoundaryWithAttachment = (
  boundary: AmuxDbBoundary,
  attachment: { prismaCalls: number } | undefined,
): AmuxDbBoundary => {
  if (attachment === undefined) return boundary;
  if (
    !Number.isInteger(attachment.prismaCalls) ||
    attachment.prismaCalls < 1 ||
    attachment.prismaCalls > AMUX_ATTACHMENT_MAX_PRISMA_CALLS
  ) {
    throw new Error("AMUX attachment declares an invalid Prisma call budget");
  }
  return {
    ...boundary,
    prismaCallCeiling: boundary.prismaCallCeiling + attachment.prismaCalls,
  };
};

/**
 * Every AMUX database operation uses one short interactive transaction.
 *
 * The first explicit SQL installs both PostgreSQL LOCAL timeouts and a
 * database-clock deadline. The last explicit SQL query is the commit fence:
 * if the deadline was lost, the transaction rolls back. The Prisma-call count
 * does not prove an SQL statement count or a DB-enforced transaction maximum.
 *
 * A mutation transaction's fence also records its commit deadline D — the
 * earliest of its own deadline, the route deadline and every lease it
 * required, less `AMUX_DB_COMMIT_RESERVE_MS` — and refuses at that same D.
 * The deferred trigger then checks D again during COMMIT and fails a COMMIT
 * that arrives at or after it with SQLSTATE AX001, which is reported as
 * `AMUX_DB_DEADLINE_EXCEEDED`: rolled back. Any other failure after the
 * callback returned is `AMUX_DB_OUTCOME_UNKNOWN` and stays unknown until
 * authoritative read-back. A read transaction records nothing, so it gets
 * no marker and keeps its plain fence.
 *
 * Inside an admitted orchestrator write (policy version 20, section 4) a
 * mutation locks the admission row right after setup and before its work,
 * and refuses with nothing changed when the admission is closed. The receipts
 * its work records with `recordReceipt` are inserted by its commit fence, so
 * they commit exactly when its changes do. A refusal-only boundary
 * (`admissionLock: "none"`) does neither and may record no receipt.
 */
export async function withAmuxDbBoundary<T>(
  boundary: AmuxDbBoundary,
  work: (
    tx: Prisma.TransactionClient,
    context: {
      dbNow: Date;
      deadlineAt: Date;
      requireLeaseAt: (leaseExpiresAt: Date) => void;
      /** The same bounded client as `tx`, typed for an `AmuxAttachment`. */
      attachedTransaction: AmuxAttachedTransaction;
      /**
       * Records a state change this transaction makes, for the receipts of an
       * admitted orchestrator write. Outside one it records nothing.
       */
      recordReceipt: AmuxOrchestratorReceiptRecorder;
    },
  ) => Promise<T>,
): Promise<T> {
  if (
    !Number.isInteger(boundary.prismaCallCeiling) ||
    boundary.prismaCallCeiling < 2
  ) {
    throw new Error("AMUX DB boundary needs setup and commit-fence calls");
  }

  const routeDeadline = amuxRouteDeadline.getStore();
  const orchestratorWrite = routeDeadline?.orchestratorWrite;
  const locksAdmission =
    orchestratorWrite !== undefined &&
    boundary.isolation === "mutation" &&
    boundary.admissionLock !== "none";
  // The admission lock is one more call, so it widens this transaction's
  // budget; a route with no admission keeps the declared one.
  const effectiveBoundary: AmuxDbBoundary = locksAdmission
    ? {
        ...boundary,
        prismaCallCeiling:
          boundary.prismaCallCeiling + AMUX_ORCHESTRATOR_ADMISSION_LOCK_CALLS,
      }
    : boundary;
  const transactionBudgetMs = amuxDbTransactionBudgetMs(effectiveBoundary);
  const routeRemainingMs =
    routeDeadline === undefined
      ? null
      : routeDeadline.localDeadlineMs - Date.now();
  if (routeRemainingMs !== null && routeRemainingMs < transactionBudgetMs) {
    throw new AmuxDbBoundaryError(
      "AMUX_DB_DEADLINE_EXCEEDED",
      boundary.operation,
    );
  }
  const connectionWaitMs = amuxDbConnectionWaitMs(
    routeRemainingMs,
    transactionBudgetMs,
  );

  let forgetReceiptCommit: () => void = () => {};
  let phase: AmuxDbBoundaryPhase = "starting";
  const transaction = prisma.$transaction(
    async (rawTx) => {
      // Prisma runs this callback only once the connection is held and BEGIN
      // has been sent. Until this line nothing of this boundary has run.
      phase = "running";
      // From here on this route may have written, whatever becomes of this
      // transaction.
      if (boundary.isolation === "mutation" && routeDeadline !== undefined) {
        routeDeadline.mutationStarted = true;
      }
      const setup = await rawTx.$queryRaw<
        Array<{ dbNowEpochMs: bigint; deadlineAtEpochMs: bigint }>
      >`
        WITH configured AS MATERIALIZED (
          SELECT
            set_config(
              'statement_timeout',
              ${String(AMUX_DB_STATEMENT_TIMEOUT_MS)},
              true
            ) AS "statementTimeoutInstalled",
            set_config(
              'idle_in_transaction_session_timeout',
              ${String(AMUX_DB_IDLE_TRANSACTION_TIMEOUT_MS)},
              true
            ) AS "idleTimeoutInstalled",
            clock_timestamp() AS "dbNow"
        ), installed AS MATERIALIZED (
          SELECT
            "dbNow",
            "dbNow" +
              ${transactionBudgetMs} * INTERVAL '1 millisecond' AS "deadlineAt",
            "statementTimeoutInstalled",
            "idleTimeoutInstalled"
          FROM configured
        ), anchored AS MATERIALIZED (
          SELECT
            floor(extract(epoch FROM "dbNow") * 1000)::bigint
              AS "dbNowEpochMs",
            floor(extract(epoch FROM "deadlineAt") * 1000)::bigint
              AS "deadlineAtEpochMs",
            "statementTimeoutInstalled",
            "idleTimeoutInstalled",
            set_config(
              'tomverse.amux_deadline',
              "deadlineAt"::text,
              true
            ) AS "deadlineInstalled"
          FROM installed
        )
        SELECT "dbNowEpochMs", "deadlineAtEpochMs", "statementTimeoutInstalled",
          "idleTimeoutInstalled", "deadlineInstalled"
        FROM anchored
      `;

      const dbNowEpochMs = Number(setup[0]?.dbNowEpochMs);
      const deadlineAtEpochMs = Number(setup[0]?.deadlineAtEpochMs);
      if (
        !Number.isSafeInteger(dbNowEpochMs) ||
        !Number.isSafeInteger(deadlineAtEpochMs) ||
        deadlineAtEpochMs <= dbNowEpochMs
      ) {
        throw new AmuxDbBoundaryError(
          "AMUX_DB_DEADLINE_EXCEEDED",
          boundary.operation,
        );
      }
      // Prisma can decode raw timestamptz Date values using the session
      // TimeZone. Epoch milliseconds represent the same instant in every zone.
      const dbNow = new Date(dbNowEpochMs);
      const deadlineAt = new Date(deadlineAtEpochMs);

      if (routeDeadline) {
        routeDeadline.databaseDeadlineAt ??= new Date(
          dbNow.getTime() + routeDeadline.maxMs,
        );
        if (
          routeDeadline.databaseDeadlineAt.getTime() - dbNow.getTime() <
          transactionBudgetMs
        ) {
          throw new AmuxDbBoundaryError(
            "AMUX_DB_DEADLINE_EXCEEDED",
            boundary.operation,
          );
        }
      }

      const tx = boundedTransactionClient(rawTx, effectiveBoundary, 1);
      if (locksAdmission) {
        await lockAmuxRouteOrchestratorAdmission(tx, boundary.operation);
      }
      const receipts: AmuxOrchestratorReceipt[] = [];
      let leaseDeadlineAt: Date | null = null;
      const result = await work(tx, {
        dbNow,
        deadlineAt,
        attachedTransaction: tx as AmuxAttachedTransaction,
        requireLeaseAt(leaseExpiresAt) {
          if (
            leaseDeadlineAt === null ||
            leaseExpiresAt.getTime() < leaseDeadlineAt.getTime()
          ) {
            leaseDeadlineAt = leaseExpiresAt;
          }
        },
        recordReceipt(targetKind, targetId, rowCount) {
          if (boundary.isolation === "read") {
            throw new Error("A read boundary cannot record a state change");
          }
          if (orchestratorWrite === undefined) return;
          if (!locksAdmission) {
            throw new Error(
              "A refusal-only boundary cannot record a state change of an admitted write",
            );
          }
          receipts.push({ targetKind, targetId, rowCount });
        },
      });
      // Prisma DateTime values may be sent to PostgreSQL as naive timestamps.
      // Explicit UTC offsets prevent the session TimeZone from moving a lease
      // deadline when PostgreSQL coerces it to timestamptz for LEAST().
      const routeDeadlineIso = (
        routeDeadline?.databaseDeadlineAt ?? deadlineAt
      ).toISOString();
      const leaseDeadlineIso = (leaseDeadlineAt ?? deadlineAt).toISOString();
      if (boundary.isolation === "read") {
        const fence = await tx.$queryRaw<Array<{ withinDeadline: boolean }>>`
          SELECT
            clock_timestamp() <
            LEAST(
              current_setting('tomverse.amux_deadline')::timestamptz,
              ${routeDeadlineIso}::timestamptz,
              ${leaseDeadlineIso}::timestamptz
            )
            AS "withinDeadline"
        `;

        if (fence[0]?.withinDeadline !== true) {
          throw new AmuxDbBoundaryError(
            "AMUX_DB_DEADLINE_EXCEEDED",
            boundary.operation,
          );
        }
      } else {
        // One statement, three effects, one deadline D:
        // - `commit_deadline` is D, truncated to the millisecond so the stored
        //   timestamptz(3) is D exactly and never later;
        // - `marker` records D under this transaction's top-level id
        //   (txid_current() is the same inside a Prisma savepoint), which
        //   queues the deferred trigger for COMMIT. A second fence in one
        //   transaction would fail on the primary key and roll back;
        // - `commit_check` confirms that the trigger will fire: present on the
        //   table the INSERT resolved to, deferrable, initially deferred, on
        //   INSERT, enabled for an ordinary session. Without it nothing would
        //   look at D at COMMIT, so the transaction is refused.
        // The clock is compared with the stored D, the value the trigger reads.
        // An admitted orchestrator write's receipts are a fourth effect of the
        // same statement (lib/amux/orchestratorHaltStore.ts).
        const receiptSql =
          orchestratorWrite !== undefined && receipts.length > 0
            ? amuxOrchestratorReceiptInsertSql(orchestratorWrite.requestId, receipts)
            : Prisma.empty;
        // From the fence on, the receipts may reach COMMIT. The catch below
        // takes the mark back for every failure that proves they did not.
        if (orchestratorWrite !== undefined && receipts.length > 0) {
          forgetReceiptCommit = markAmuxRouteOrchestratorReceiptsCommitting();
        }
        const fence = await tx.$queryRaw<AmuxCommitFenceRow[]>`
          WITH commit_deadline AS MATERIALIZED (
            SELECT date_trunc(
              'milliseconds',
              LEAST(
                current_setting('tomverse.amux_deadline')::timestamptz,
                ${routeDeadlineIso}::timestamptz,
                ${leaseDeadlineIso}::timestamptz
              ) - ${AMUX_DB_COMMIT_RESERVE_MS} * INTERVAL '1 millisecond'
            ) AS "deadline"
          ), marker AS (
            INSERT INTO "AmuxCommitDeadline" ("txid", "deadline", "operation")
            SELECT txid_current(), "deadline", ${boundary.operation}
            FROM commit_deadline
            RETURNING "deadline"
          ), commit_check AS MATERIALIZED (
            SELECT (
              EXISTS (
                SELECT 1
                FROM pg_catalog.pg_trigger t
                JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
                WHERE c.oid = to_regclass('"AmuxCommitDeadline"')
                  AND t.tgname = ${AMUX_COMMIT_DEADLINE_TRIGGER}
                  AND t.tgdeferrable
                  AND t.tginitdeferred
                  AND t.tgenabled = 'O'
                  AND (t.tgtype::integer & 4) <> 0
              )
              AND current_setting('session_replication_role') <> 'replica'
            ) AS "installed"
          )${receiptSql}
          SELECT
            clock_timestamp() < marker."deadline" AS "withinDeadline",
            commit_check."installed" AS "commitCheckInstalled"
          FROM marker CROSS JOIN commit_check
        `;
        requireAmuxCommitFence(fence, boundary.operation);
      }

      // Nothing may run after this line inside the callback: from here on a
      // failure can only come from the COMMIT itself.
      phase = "committing";
      return result;
    },
    {
      maxWait: connectionWaitMs,
      timeout: transactionBudgetMs + AMUX_DB_TRANSACTION_TIMEOUT_SLACK_MS,
      isolationLevel:
        boundary.isolation === "read"
          ? Prisma.TransactionIsolationLevel.RepeatableRead
          : Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  );
  return transaction.catch((error: unknown): never => {
    // The route's write state when this transaction failed, not when it began:
    // a mutation of the same route that started meanwhile counts, this one
    // included once its callback began.
    const failure = amuxDbBoundaryFailure(
      boundary,
      phase,
      error,
      amuxRouteWriteState(routeDeadline),
    );
    // Receipts of a transaction that failed before COMMIT, or whose COMMIT the
    // commit deadline trigger refused (AX001), were rolled back with
    // everything else. Any other COMMIT failure may have committed them, so
    // the mark stays and the route answers an unknown outcome.
    if (phase !== "committing" || isAmuxLateCommitError(error)) {
      forgetReceiptCommit();
    }
    if (isAmuxDbBusyError(failure)) {
      failure.connectionWaitMs = connectionWaitMs;
      failure.poolUsage = safePoolUsage();
    }
    throw failure;
  });
}
