import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

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
// 16 lacks that setting. Future execution stays hard-disabled until the DB is
// proven to prevent a late run from being recorded as success. Neither a SQL
// statement-count cap nor a whole-transaction time bound is itself required.
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
} as const satisfies Record<string, AmuxDbBoundary>;

export class AmuxDbBoundaryError extends Error {
  readonly code:
    "AMUX_DB_DEADLINE_EXCEEDED" | "AMUX_DB_PRISMA_CALL_CEILING_EXCEEDED";

  constructor(
    code: "AMUX_DB_DEADLINE_EXCEEDED" | "AMUX_DB_PRISMA_CALL_CEILING_EXCEEDED",
    operation: string,
  ) {
    super(`${code}:${operation}`);
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

export const amuxRouteHasBudgetFor = (boundary: AmuxDbBoundary): boolean => {
  const deadline = amuxRouteDeadline.getStore();
  if (!deadline) return true;
  const maxMs = amuxDbTransactionBudgetMs(boundary);
  // Coarse admission only. The authoritative cross-transaction limit is
  // checked against the PostgreSQL clock in each transaction setup/fence.
  return deadline.localDeadlineMs - Date.now() >= maxMs;
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

/**
 * Every AMUX database operation uses one short interactive transaction.
 *
 * The first explicit SQL installs both PostgreSQL LOCAL timeouts and a
 * database-clock deadline. The last explicit SQL query is the commit fence:
 * if the deadline was lost, the transaction rolls back. The Prisma-call count
 * does not prove an SQL statement count or a DB-enforced transaction maximum.
 * The fence is a DB-clock decision before COMMIT, not proof that COMMIT
 * completed before the deadline. A lost response or ambiguous COMMIT remains
 * pending/unknown until authoritative read-back.
 */
export async function withAmuxDbBoundary<T>(
  boundary: AmuxDbBoundary,
  work: (
    tx: Prisma.TransactionClient,
    context: {
      dbNow: Date;
      deadlineAt: Date;
      requireLeaseAt: (leaseExpiresAt: Date) => void;
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

  return prisma.$transaction(
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
}
