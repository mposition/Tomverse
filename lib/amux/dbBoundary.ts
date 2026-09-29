import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  AMUX_COMMIT_DEADLINE_TRIGGER,
  isAmuxLateCommitError,
} from "@/lib/amux/commitDeadlineCore";

export const AMUX_DB_STATEMENT_TIMEOUT_MS = 200;
export const AMUX_DB_IDLE_TRANSACTION_TIMEOUT_MS = 100;
export const AMUX_DB_COMMIT_RESERVE_MS = 200;
export const AMUX_DB_MAX_WAIT_MS = 250;
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
};

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
  routingSnapshot: {
    operation: "routing_snapshot",
    prismaCallCeiling: 6,
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
  claim: { operation: "claim", prismaCallCeiling: 17, isolation: "mutation" },
  claimRefusal: {
    operation: "claim_refusal",
    prismaCallCeiling: 6,
    isolation: "mutation",
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
 */
export type AmuxDbBoundaryErrorCode =
  | "AMUX_DB_DEADLINE_EXCEEDED"
  | "AMUX_DB_PRISMA_CALL_CEILING_EXCEEDED"
  | "AMUX_DB_COMMIT_CHECK_MISSING"
  | "AMUX_DB_OUTCOME_UNKNOWN";

export class AmuxDbBoundaryError extends Error {
  readonly code: AmuxDbBoundaryErrorCode;

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
};
const amuxRouteDeadline = new AsyncLocalStorage<AmuxRouteDeadline>();

export const amuxDbTransactionBudgetMs = (boundary: AmuxDbBoundary) =>
  boundary.prismaCallCeiling * AMUX_DB_STATEMENT_TIMEOUT_MS +
  boundary.prismaCallCeiling * AMUX_DB_IDLE_TRANSACTION_TIMEOUT_MS +
  AMUX_DB_COMMIT_RESERVE_MS;

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
): Promise<void> {
  if (deadlineAt === null) return;
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

/** Where a bounded transaction was when it failed. */
export type AmuxDbBoundaryPhase = "running" | "committing";

/**
 * What a failed bounded transaction is reported as.
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
 * unchanged, as is every failure before COMMIT. A read transaction records
 * nothing, so a failure of its COMMIT is passed on unchanged too.
 */
export const amuxDbBoundaryFailure = (
  boundary: AmuxDbBoundary,
  phase: AmuxDbBoundaryPhase,
  error: unknown,
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
  return error;
};

export const withAmuxRouteBudget = <T>(
  work: () => Promise<T>,
  maxMs = AMUX_ROUTE_BUDGET_MS,
): Promise<T> =>
  amuxRouteDeadline.run({ localDeadlineMs: Date.now() + maxMs, maxMs }, work);

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
  const transactionBudgetMs = amuxDbTransactionBudgetMs(boundary);
  if (
    routeDeadline !== undefined &&
    routeDeadline.localDeadlineMs - Date.now() < transactionBudgetMs
  ) {
    throw new AmuxDbBoundaryError(
      "AMUX_DB_DEADLINE_EXCEEDED",
      boundary.operation,
    );
  }

  let phase: AmuxDbBoundaryPhase = "running";
  const transaction = prisma.$transaction(
    async (rawTx) => {
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

      const tx = boundedTransactionClient(rawTx, boundary, 1);
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
          )
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
      maxWait: AMUX_DB_MAX_WAIT_MS,
      timeout: transactionBudgetMs + 300,
      isolationLevel:
        boundary.isolation === "read"
          ? Prisma.TransactionIsolationLevel.RepeatableRead
          : Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  );
  return transaction.catch((error: unknown): never => {
    throw amuxDbBoundaryFailure(boundary, phase, error);
  });
}
