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
  MARKETING_PUBLISHER_STATEMENT_TIMEOUT_MS,
  MARKETING_PUBLISHER_TRANSACTION_TIMEOUT_MS,
} from "@/lib/marketingPublisherRunCore";

/** A run request the route has already parsed and checked. */
export type MarketingPublisherRunStart = {
  readonly runId: string;
  readonly deadlineAt: Date;
};

export type MarketingPublisherRunStartResult =
  | { readonly started: true; readonly runId: string }
  | {
      readonly started: false;
      readonly reason: "already_running" | "already_closed" | "deadline_mismatch";
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

/** Record that the run is still alive. The trigger stamps the database's time. */
export async function heartbeatMarketingPublisherRun(
  client: PrismaClient,
  runId: string,
): Promise<boolean> {
  const updated = await client.scheduledJobRun.updateMany({
    where: {
      id: runId,
      jobKey: MARKETING_PUBLISHER_JOB_KEY,
      status: "running",
    },
    // The value is overwritten by the trigger with the database clock; what
    // matters is that the column changes, which is what the trigger looks for.
    data: { heartbeatAt: new Date() },
  });
  return updated.count === 1;
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
): Promise<{ readonly status: "succeeded" | "failed" }> {
  const close = (data: Prisma.ScheduledJobRunUpdateManyMutationInput) =>
    client.scheduledJobRun.updateMany({
      where: {
        id: runId,
        jobKey: MARKETING_PUBLISHER_JOB_KEY,
        status: "running",
      },
      data,
    });

  if (outcome.status === "succeeded") {
    try {
      await close({
        status: "succeeded",
        processedCount: outcome.processedCount,
        result: outcome.result,
        error: null,
        // Overwritten by the trigger with the database clock.
        completedAt: new Date(),
      });
      return { status: "succeeded" };
    } catch (error) {
      if (!isDeadlineRefusal(error)) throw error;
      await close({
        status: "failed",
        error: "deadline_exceeded",
        result: outcome.result,
        processedCount: outcome.processedCount,
        completedAt: new Date(),
      });
      return { status: "failed" };
    }
  }

  await close({
    status: "failed",
    error: outcome.error.slice(0, 4_000),
    ...(outcome.result === undefined ? {} : { result: outcome.result }),
    completedAt: new Date(),
  });
  return { status: "failed" };
}

const isDeadlineRefusal = (error: unknown): boolean =>
  error instanceof Error && /after its deadline/.test(error.message);

/** Why a bounded transaction refused to run or to continue. */
export class MarketingPublisherTransactionRefusedError extends Error {
  readonly code: "server_too_old" | "statement_budget_exhausted";

  constructor(
    code: "server_too_old" | "statement_budget_exhausted",
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
