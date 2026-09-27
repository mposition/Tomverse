/**
 * Recording a marketing publisher run, and the transaction every batch runs in.
 *
 * Contract: the S2 plan's "S2d1", foundation r13 section 6.2a, and the timing
 * rules in lib/marketingPublisherRunCore.ts.
 *
 * The run row is `ScheduledJobRun`, with `id` set to the run id the service
 * generated and a `deadlineAt`. A trigger on that table
 * (20260923180000_marketing_publisher_run_deadline) stamps its times from the
 * database clock and refuses `succeeded` for a run that closed late; this
 * module is the caller that is written to expect that, not the thing that
 * enforces it.
 */

import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";


import {
  MARKETING_PUBLISHER_IDLE_TIMEOUT_MS,
  MARKETING_PUBLISHER_JOB_KEY,
  MARKETING_PUBLISHER_MAX_STATEMENTS,
  MARKETING_PUBLISHER_MIN_SERVER_VERSION_NUM,
  MARKETING_PUBLISHER_SILENCE_THRESHOLD_MS,
  MARKETING_PUBLISHER_STATEMENT_TIMEOUT_MS,
  MARKETING_PUBLISHER_TRANSACTION_TIMEOUT_MS,
} from "@/lib/marketingPublisherRunCore";

/**
 * The SQLSTATEs the deadline trigger raises for the two refusals this module
 * acts on. Matched on the driver's code, which is stable, and only then on the
 * message, which is a fallback for a driver that does not pass the code
 * through.
 */
export const MARKETING_PUBLISHER_LATE_SUCCESS_SQLSTATE = "TMDL1";
export const MARKETING_PUBLISHER_START_AFTER_DEADLINE_SQLSTATE = "TMDL2";
export const MARKETING_PUBLISHER_HEARTBEAT_AFTER_DEADLINE_SQLSTATE = "TMDL3";

/**
 * Whether a database error was raised with this SQLSTATE, wherever Prisma put it.
 *
 * Not `databaseErrorMetadata(error).driverCode`, which reads `error.cause`.
 * For a code the pg adapter does not map -- and a trigger's own code is one --
 * Prisma throws a `PrismaClientKnownRequestError` (`P2039`) that has **no
 * `cause` at all**; the adapter's error, carrying the code, is at
 * `meta.driverAdapterError.cause.originalCode`. That was checked by building
 * the error with Prisma's own class, not assumed. The version this replaces
 * read `cause`, matched nothing in production, and had a unit test that built
 * an error with a `cause` Prisma never produces -- so the test passed and the
 * path was dead.
 *
 * Walked structurally, the way `isStatementTimeout` in
 * lib/conversationSearchResults.ts already does for 57014 -- through `cause`,
 * `meta` and `driverAdapterError` -- so a change in how deeply the adapter
 * wraps it does not hide the code.
 */
const hasSqlstate = (error: unknown, wanted: string): boolean => {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record.code === wanted || record.originalCode === wanted) return true;
    queue.push(record.cause, record.meta, record.driverAdapterError);
  }
  return false;
};

/** The SQLSTATE first; the message only if no code could be found anywhere. */
const raisedWith = (error: unknown, sqlstate: string, fallback: RegExp): boolean => {
  if (hasSqlstate(error, sqlstate)) return true;
  return error instanceof Error && fallback.test(error.message);
};

/** A run request the route has already parsed and checked. */
export type MarketingPublisherRunStart = {
  readonly runId: string;
  readonly deadlineAt: Date;
};

export type MarketingPublisherRunStartResult =
  | { readonly started: true; readonly runId: string }
  | {
      readonly started: false;
      readonly reason:
        | "already_running"
        | "already_closed"
        | "deadline_mismatch"
        | "deadline_passed_at_database";
    };

/**
 * Open the run row, or say why this request is not a new run.
 *
 * A duplicate run id is never a second run. The same id with the same deadline
 * while the first is still running is a retry of the same request -- the
 * service's HTTP client can resend -- and is answered as "already running"
 * without doing the work twice. The same id with a different deadline, or for a
 * run that has closed, is refused: it is either a bug or a replay.
 */
export async function startMarketingPublisherRun(
  client: PrismaClient,
  input: MarketingPublisherRunStart,
): Promise<MarketingPublisherRunStartResult> {
  try {
    await client.scheduledJobRun.create({
      data: {
        id: input.runId,
        jobKey: MARKETING_PUBLISHER_JOB_KEY,
        status: "running",
        source: "marketing_publisher_service",
        deadlineAt: input.deadlineAt,
      },
      select: { id: true },
    });
    return { started: true, runId: input.runId };
  } catch (error) {
    // The route checked the deadline against its own clock; the trigger
    // checks it against the database's. When the two disagree -- a skewed
    // clock, or a request that sat in a queue -- the database is right, and
    // the answer is that this run cannot start, not a 500.
    if (
      raisedWith(
        error,
        MARKETING_PUBLISHER_START_AFTER_DEADLINE_SQLSTATE,
        /cannot start after its own deadline/,
      )
    ) {
      return { started: false, reason: "deadline_passed_at_database" };
    }
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== "P2002"
    ) {
      throw error;
    }
  }

  const existing = await client.scheduledJobRun.findUnique({
    where: { id: input.runId },
    select: { jobKey: true, status: true, deadlineAt: true },
  });
  if (
    !existing ||
    existing.jobKey !== MARKETING_PUBLISHER_JOB_KEY ||
    existing.deadlineAt?.getTime() !== input.deadlineAt.getTime()
  ) {
    return { started: false, reason: "deadline_mismatch" };
  }
  return {
    started: false,
    reason: existing.status === "running" ? "already_running" : "already_closed",
  };
}

/** What a heartbeat found, rather than a boolean that cannot say which. */
export type MarketingPublisherHeartbeat =
  | { readonly beat: true }
  | { readonly beat: false; readonly reason: "not_running" | "past_deadline" };

/**
 * Record that the run is still alive. The trigger stamps the database's time.
 *
 * Two different answers, and the caller acts differently on each. `not_running`
 * means something else closed the row -- this request no longer owns the run.
 * `past_deadline` means the run is over on the database's clock, whatever this
 * process believes; the trigger refuses the write rather than let a beat move
 * the row's last sign of life forward past its own deadline.
 */
export async function heartbeatMarketingPublisherRun(
  client: PrismaClient,
  runId: string,
): Promise<MarketingPublisherHeartbeat> {
  try {
    const updated = await client.scheduledJobRun.updateMany({
      where: {
        id: runId,
        jobKey: MARKETING_PUBLISHER_JOB_KEY,
        status: "running",
      },
      // The value is overwritten by the trigger with the database clock; what
      // matters is that the column changes, which is what the trigger looks
      // for.
      data: { heartbeatAt: new Date() },
    });
    return updated.count === 1
      ? { beat: true }
      : { beat: false, reason: "not_running" };
  } catch (error) {
    if (hasSqlstate(error, MARKETING_PUBLISHER_HEARTBEAT_AFTER_DEADLINE_SQLSTATE)) {
      return { beat: false, reason: "past_deadline" };
    }
    throw error;
  }
}

/**
 * The publisher runs that started and then went quiet, and how many there are.
 *
 * **One statement, so the rule, the order and the count are one read.** Three
 * versions of this were wrong, each because part of the question was answered
 * outside the database.
 *
 * The first filtered on `startedAt` alone and took fifty rows with no order, so
 * fifty rows that started hours ago and beat a second ago could fill the page
 * and leave the one silent run outside it.
 *
 * The second ordered by `heartbeatAt` with nulls first -- which is not the value
 * the rule compares. The last sign of life is `COALESCE(heartbeatAt, startedAt)`,
 * so a row that never beat and started sixteen minutes ago sorted *ahead* of one
 * whose heartbeat was ten hours ago, and the ten-hour row was the one cut. The
 * alert then named sixteen minutes as its oldest.
 *
 * The third read the count and the rows as two queries, which are two
 * snapshots: ten silent rows could be counted, nine recover, and the incident
 * would report ten while carrying evidence for one.
 *
 * Prisma cannot order by an expression, so this is raw SQL -- and being one raw
 * statement is what makes the count and the page the same snapshot. It is a
 * read; the protected-writer check is about writes.
 */
export async function findSilentMarketingPublisherRuns(
  client: PrismaClient,
  now: Date,
  thresholdMs: number = MARKETING_PUBLISHER_SILENCE_THRESHOLD_MS,
): Promise<{
  readonly total: number;
  readonly runs: Array<{ id: string; startedAt: Date; heartbeatAt: Date | null }>;
}> {
  const cutoff = new Date(now.getTime() - thresholdMs);
  const rows = await client.$queryRaw<
    Array<{ total: bigint; id: string; startedAt: Date; heartbeatAt: Date | null }>
  >(Prisma.sql`
    WITH silent AS (
      SELECT
        "id",
        "startedAt",
        "heartbeatAt",
        COALESCE("heartbeatAt", "startedAt") AS last_seen
      FROM "ScheduledJobRun"
      WHERE "jobKey" = ${MARKETING_PUBLISHER_JOB_KEY}
        AND "status" = 'running'
        AND COALESCE("heartbeatAt", "startedAt") < ${cutoff}
    )
    SELECT
      (SELECT count(*) FROM silent) AS "total",
      "id",
      "startedAt",
      "heartbeatAt"
    FROM silent
    ORDER BY last_seen ASC
    -- Bounded: this is an alert, and one incident naming the count says as much
    -- as fifty naming each row. The count above is not capped by this limit.
    LIMIT 50
  `);
  return {
    total: Number(rows[0]?.total ?? 0),
    runs: rows.map((row) => ({
      id: row.id,
      startedAt: row.startedAt,
      heartbeatAt: row.heartbeatAt,
    })),
  };
}

export type MarketingPublisherRunOutcome =
  | { readonly status: "succeeded"; readonly processedCount: number; readonly result: Prisma.InputJsonValue }
  | { readonly status: "failed"; readonly error: string; readonly result?: Prisma.InputJsonValue };

/**
 * Close the run.
 *
 * A caller that asks for `succeeded` after its deadline gets a refusal from the
 * trigger. That is caught here and the run is closed as `failed` with the
 * reason instead -- the plan's "late, failed or unknown, never succeeded" --
 * because the alternative is a row left `running` that the silence monitor
 * would then report as a dead worker, which it is not.
 */
export async function finishMarketingPublisherRun(
  client: PrismaClient,
  runId: string,
  outcome: MarketingPublisherRunOutcome,
): Promise<{ readonly status: "succeeded" | "failed" | "not_running" }> {
  // Each close says how many rows it closed. Zero is not success: it means
  // the run was already closed -- by a concurrent request, or by an earlier
  // attempt at this one -- or never existed, and reporting "succeeded" for it
  // would have the route say something the row does not.
  const close = async (data: Prisma.ScheduledJobRunUpdateManyMutationInput) =>
    (
      await client.scheduledJobRun.updateMany({
        where: {
          id: runId,
          jobKey: MARKETING_PUBLISHER_JOB_KEY,
          status: "running",
        },
        data,
      })
    ).count === 1;

  if (outcome.status === "succeeded") {
    try {
      const closed = await close({
        status: "succeeded",
        processedCount: outcome.processedCount,
        result: outcome.result,
        error: null,
        // Overwritten by the trigger with the database clock.
        completedAt: new Date(),
      });
      return { status: closed ? "succeeded" : "not_running" };
    } catch (error) {
      if (
        !raisedWith(error, MARKETING_PUBLISHER_LATE_SUCCESS_SQLSTATE, /after its deadline/)
      ) {
        throw error;
      }
      const closed = await close({
        status: "failed",
        error: "deadline_exceeded",
        result: outcome.result,
        processedCount: outcome.processedCount,
        completedAt: new Date(),
      });
      return { status: closed ? "failed" : "not_running" };
    }
  }

  const closed = await close({
    status: "failed",
    error: outcome.error.slice(0, 4_000),
    ...(outcome.result === undefined ? {} : { result: outcome.result }),
    completedAt: new Date(),
  });
  return { status: closed ? "failed" : "not_running" };
}

/** Why a bounded transaction refused to run or to continue. */
export class MarketingPublisherTransactionRefusedError extends Error {
  readonly code:
    | "server_too_old"
    | "statement_budget_exhausted"
    | "transaction_timeout_already_armed";

  constructor(
    code:
      | "server_too_old"
      | "statement_budget_exhausted"
      | "transaction_timeout_already_armed",
    message: string,
  ) {
    super(message);
    this.name = "MarketingPublisherTransactionRefusedError";
    this.code = code;
  }
}

/**
 * Run `work` in one transaction that cannot outlast the derived maximum.
 *
 * Three database ceilings and one application one:
 *
 * - `transaction_timeout`, set first, bounds the whole transaction from here
 *   on. PostgreSQL 17 only: on 16 the setting does not exist, the bound the
 *   contract promises cannot be had, and this refuses rather than run without
 *   it. The server version is a runtime fact, read each time, because a
 *   managed database can be restored onto a different major.
 * - `statement_timeout` and `idle_in_transaction_session_timeout`, set after
 *   it and shorter than it, so PostgreSQL arms them.
 * - At most `MARKETING_PUBLISHER_MAX_STATEMENTS` statements issued by `work`,
 *   counted here, because PostgreSQL has no statement counter.
 *
 * The four `SET LOCAL` and version statements are this wrapper's own and are
 * not counted against `work`.
 */
export async function runBoundedMarketingTransaction<T>(
  client: PrismaClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(
    async (tx) => {
      const version = await tx.$queryRaw<Array<{ num: number }>>(Prisma.sql`
        SELECT current_setting('server_version_num')::int AS "num"
      `);
      const num = Number(version[0]?.num ?? 0);
      if (!(num >= MARKETING_PUBLISHER_MIN_SERVER_VERSION_NUM)) {
        throw new MarketingPublisherTransactionRefusedError(
          "server_too_old",
          `PostgreSQL ${num} has no transaction_timeout, so the publisher's per-transaction bound cannot be enforced`,
        );
      }

      // **A timer that is already running is not one this function set.**
      //
      // PostgreSQL 17's `assign_transaction_timeout` starts a timer only when
      // one is *not already active* -- which is the same sentence foundation
      // r13 quotes. So if the role, database or session default already gave
      // this connection a `transaction_timeout`, the timer started at `BEGIN`
      // with that value, and setting the GUC here changes what
      // `current_setting` reports without rescheduling anything. The bound in
      // force would be somebody else's, and the 115 seconds this function
      // promises would be a number in a variable.
      //
      // Whether any such default exists is a fact about the deployment, not
      // about this repository -- the same kind of fact as the server version --
      // so it is read rather than assumed, and a non-zero answer is a refusal.
      // Refusing is right even when the pre-existing bound is *shorter*: this
      // function's contract is a stated bound, and one it cannot state is not
      // one it can keep.
      const existing = await tx.$queryRaw<Array<{ value: string }>>(Prisma.sql`
        SELECT current_setting('transaction_timeout') AS "value"
      `);
      const already = String(existing[0]?.value ?? "").trim();
      if (already !== "0" && already !== "0ms") {
        throw new MarketingPublisherTransactionRefusedError(
          "transaction_timeout_already_armed",
          `This connection opened with transaction_timeout=${already}, so a timer is already running and cannot be rescheduled to this transaction's bound`,
        );
      }

      // Order matters and is pinned by a test: the transaction timeout first,
      // then the two ceilings that are only armed while shorter than it.
      //
      // `set_config(name, value, true)` rather than `SET LOCAL`: it is the same
      // transaction-local setting and runs the same assign hook -- which is
      // what arms `transaction_timeout` on the transaction already open -- but
      // it takes bound parameters, where `SET` takes only literal text. The
      // values are this module's own constants either way; a statement built
      // by string is still a statement the writer check cannot tell from one
      // built from input.
      await tx.$queryRaw(Prisma.sql`
        SELECT set_config(
          'transaction_timeout',
          ${String(Math.floor(MARKETING_PUBLISHER_TRANSACTION_TIMEOUT_MS))},
          true
        )
      `);
      await tx.$queryRaw(Prisma.sql`
        SELECT set_config(
          'statement_timeout',
          ${String(Math.floor(MARKETING_PUBLISHER_STATEMENT_TIMEOUT_MS))},
          true
        )
      `);
      await tx.$queryRaw(Prisma.sql`
        SELECT set_config(
          'idle_in_transaction_session_timeout',
          ${String(Math.floor(MARKETING_PUBLISHER_IDLE_TIMEOUT_MS))},
          true
        )
      `);

      return work(countingTransaction(tx));
    },
    {
      isolationLevel: "Serializable",
      // Prisma's own ceiling on the interactive transaction, set above the
      // database's so the database is the one that says no.
      timeout: MARKETING_PUBLISHER_TRANSACTION_TIMEOUT_MS + 5_000,
    },
  );
}

/**
 * A transaction client that refuses its thirteenth statement.
 *
 * Every model delegate call and every raw query is one statement. Counted on
 * the call, not on completion, so a statement that is slow still spends its
 * place.
 *
 * What it counts is what the plan names: statements *in application code*.
 * One Prisma call can send more than one SQL statement -- an `include` is a
 * second query -- so twelve is a count of calls rather than of SQL, which is
 * why the plan calls the derived maximum an application figure and names
 * `transaction_timeout` as the bound that actually holds.
 *
 * Work that reaches for the module-level client instead of the `tx` it was
 * given is a different matter, and not a caveat to this count: it is on
 * another connection, where none of the three timeouts apply and whose writes
 * can commit after this transaction rolls back or after the run's deadline has
 * passed and the run has been recorded failed. A proxy cannot see it, because
 * it does not go through the proxy. It is refused in source instead, by
 * `tests/marketingPublisherBoundedCallers.test.mjs`, before the first caller
 * is written.
 */
const countingTransaction = (tx: Prisma.TransactionClient): Prisma.TransactionClient => {
  let issued = 0;
  const spend = () => {
    issued += 1;
    if (issued > MARKETING_PUBLISHER_MAX_STATEMENTS) {
      throw new MarketingPublisherTransactionRefusedError(
        "statement_budget_exhausted",
        `A publisher transaction may issue at most ${MARKETING_PUBLISHER_MAX_STATEMENTS} statements`,
      );
    }
  };
  const wrapFunction = (target: object, key: string | symbol) => {
    const value = Reflect.get(target, key) as unknown;
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      spend();
      return (value as (...a: unknown[]) => unknown).apply(target, args);
    };
  };
  return new Proxy(tx, {
    get(target, key) {
      // A transaction inside this one would be a place for statements the
      // counter does not see. Prisma does not support nesting on a
      // transaction client anyway; refusing it here says why.
      if (key === "$transaction") {
        return () => {
          throw new MarketingPublisherTransactionRefusedError(
            "statement_budget_exhausted",
            "A publisher transaction cannot open another transaction inside its budget",
          );
        };
      }
      if (typeof key === "string" && key.startsWith("$")) {
        return wrapFunction(target, key);
      }
      const delegate = Reflect.get(target, key) as unknown;
      if (delegate && typeof delegate === "object") {
        return new Proxy(delegate as object, {
          get: (inner, method) => wrapFunction(inner, method),
        });
      }
      return delegate;
    },
  }) as Prisma.TransactionClient;
};
