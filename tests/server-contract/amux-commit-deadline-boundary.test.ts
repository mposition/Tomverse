import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

// How a bounded AMUX transaction is reported when it fails at each point,
// against the real Prisma client and the real pg adapter. Only the connection
// is scripted: every SQL text the adapter sends reaches `answer` below, which
// plays the database, including the COMMIT that the commit deadline trigger
// refuses with SQLSTATE AX001 (orchestration policy version 18).
//
// This is what cannot be shown with a hand-built error: at COMMIT the Prisma 7
// transaction manager rethrows the adapter's DriverAdapterError as it is, with
// the SQLSTATE only at `cause.code` -- there is no top-level `code` and no
// `meta`. The database itself is exercised by the routing lane
// (tests/integration/amux-orchestration.db.test.ts).

const ROOT = resolve(import.meta.dirname, "..", "..");
const moduleUrl = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

type Script = {
  fenceWithinDeadline: boolean;
  commitCheckInstalled: boolean;
  /** Raised by the database when the COMMIT arrives; null commits. */
  commitError: Error | null;
  /** Raised by the callback's own statement; null succeeds. */
  callbackError: Error | null;
  /** How long the pool takes to hand out a connection; 0 is at once. */
  connectDelayMs: number;
  /** How long the callback's own statement takes; 0 is at once. */
  callbackDelayMs: number;
};
let script: Script;
let sent: Array<{ text: string; values: unknown[] }> = [];

const databaseError = (code: string, message: string) => {
  const error = new pg.DatabaseError(message, 0, "error");
  error.code = code;
  error.severity = "ERROR";
  return error;
};

const answer = (text: string) => {
  const result = (fields: Array<[string, number]>, row: unknown[]) => ({
    fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID })),
    rows: [row],
    rowCount: 1,
  });
  if (text === "COMMIT") {
    return script.commitError ? Promise.reject(script.commitError) : Promise.resolve({ fields: [], rows: [], rowCount: 0 });
  }
  if (text.includes("'tomverse.amux_deadline',") && text.includes('"deadlineAtEpochMs"')) {
    const now = Date.now();
    return Promise.resolve(
      result(
        [
          ["dbNowEpochMs", 20],
          ["deadlineAtEpochMs", 20],
          ["statementTimeoutInstalled", 25],
          ["idleTimeoutInstalled", 25],
          ["deadlineInstalled", 25],
        ],
        [String(now), String(now + 5_000), "200ms", "100ms", "x"],
      ),
    );
  }
  if (text.includes('AS "withinDeadline"')) {
    return Promise.resolve(
      text.includes('AS "commitCheckInstalled"')
        ? result(
            [
              ["withinDeadline", 16],
              ["commitCheckInstalled", 16],
            ],
            [script.fenceWithinDeadline, script.commitCheckInstalled],
          )
        : result([["withinDeadline", 16]], [script.fenceWithinDeadline]),
    );
  }
  if (text.includes("callback_statement")) {
    const { callbackError, callbackDelayMs } = script;
    const outcome = () =>
      callbackError
        ? Promise.reject(callbackError)
        : Promise.resolve(result([["callback_statement", 23]], [1]));
    return callbackDelayMs > 0
      ? new Promise((resolve) => setTimeout(resolve, callbackDelayMs)).then(outcome)
      : outcome();
  }
  return Promise.resolve({ fields: [], rows: [], rowCount: 0 });
};

const pool = new pg.Pool({ connectionString: "postgres://contract@127.0.0.1:1/amux_contract_test" });
const connection = {
  query(config: string | { text: string; values?: unknown[] }) {
    const text = typeof config === "string" ? config : config.text;
    sent.push({ text, values: typeof config === "string" ? [] : (config.values ?? []) });
    return answer(text);
  },
  release() {},
  on() {},
  removeListener() {},
};
(pool as unknown as { connect: () => Promise<unknown> }).connect = async () => {
  // A pool with no free connection: Prisma's transaction manager gives up at
  // maxWait with its own P2028, the error production logged.
  if (script.connectDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, script.connectDelayMs));
  }
  return connection;
};
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

// The pool's counts as a busy answer logs them; fixed, so the log line is checked.
const POOL_USAGE = { total: 10, idle: 0, waiting: 3 };
mock.module(moduleUrl("lib/prisma.ts"), {
  namedExports: { prisma, prismaPoolUsage: () => POOL_USAGE },
});

const load = async () => ({
  ...(await import(moduleUrl("lib/amux/dbBoundary.ts"))),
  ...(await import(moduleUrl("lib/amux/commitDeadlineCore.ts"))),
  ...(await import(moduleUrl("lib/amux/internalRoute.ts"))),
  ...(await import(moduleUrl("lib/amux/autoPromotionCore.ts"))),
});
let loaded: ReturnType<typeof load> | undefined;
const modules = () => (loaded ??= load());

const MUTATION = { operation: "commit_contract", prismaCallCeiling: 4, isolation: "mutation" } as const;
const READ = { operation: "commit_contract_read", prismaCallCeiling: 4, isolation: "read" } as const;

const reset = (overrides: Partial<Script> = {}) => {
  script = {
    fenceWithinDeadline: true,
    commitCheckInstalled: true,
    commitError: null,
    callbackError: null,
    connectDelayMs: 0,
    callbackDelayMs: 0,
    ...overrides,
  };
  sent = [];
};

// Setup, the callback's statement and the fence: three calls, a 1,100 ms budget.
const READ_SMALL = { operation: "commit_contract_read_small", prismaCallCeiling: 3, isolation: "read" } as const;

const run = async (boundary: typeof MUTATION | typeof READ | typeof READ_SMALL) => {
  const { withAmuxDbBoundary } = await modules();
  return withAmuxDbBoundary(boundary, async (tx: PrismaClient) => {
    await tx.$queryRaw`SELECT 1 AS callback_statement`;
    return "result";
  });
};

const texts = () => sent.map((entry) => entry.text);
type Failure = Error & { code?: unknown; cause?: unknown; connectionWaitMs?: unknown };
const caught = async (promise: Promise<unknown>): Promise<Failure> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error as Failure;
  }
  assert.fail("expected the transaction to fail");
};

test("an on-time mutation records its commit deadline in the fence and commits", async () => {
  reset();
  assert.equal(await run(MUTATION), "result");
  const fence = sent.find((entry) => entry.text.includes('AS "withinDeadline"'));
  assert.ok(fence);
  assert.match(fence.text, /INSERT INTO "AmuxCommitDeadline" \("txid", "deadline", "operation"\)/);
  assert.match(fence.text, /SELECT txid_current\(\), "deadline", \$\d+/);
  assert.match(fence.text, /clock_timestamp\(\) < marker\."deadline" AS "withinDeadline"/);
  assert.match(fence.text, /- \$\d+ \* INTERVAL '1 millisecond'/);
  assert.ok(fence.values.includes("commit_contract"), "the marker names the operation");
  assert.ok(fence.values.includes(200), "the reserve is AMUX_DB_COMMIT_RESERVE_MS");
  assert.ok(fence.values.includes("amux_commit_deadline_check"), "the fence checks the named trigger");
  assert.deepEqual(texts().slice(-1), ["COMMIT"]);
  // The fence is the last statement before COMMIT.
  assert.equal(texts().at(-2), fence.text);
  assert.equal(texts().filter((text) => /SET CONSTRAINTS/i.test(text)).length, 0);
});

test("a COMMIT refused with AX001 is a known deadline refusal, read before the committing phase", async () => {
  const { AmuxDbBoundaryError, isAmuxLateCommitError } = await modules();
  reset({ commitError: databaseError("AX001", "AMUX_LATE_COMMIT") });
  const error = await caught(run(MUTATION));
  assert.ok(error instanceof AmuxDbBoundaryError);
  assert.equal(error.code, "AMUX_DB_DEADLINE_EXCEEDED");
  // The raw error, before mapping, is the adapter's own shape.
  const raw = error.cause as { name?: unknown; code?: unknown; meta?: unknown; cause?: Record<string, unknown> };
  assert.equal(raw.name, "DriverAdapterError");
  assert.equal(raw.code, undefined);
  assert.equal(raw.meta, undefined);
  assert.equal(raw.cause?.kind, "postgres");
  assert.equal(raw.cause?.code, "AX001");
  assert.equal(raw.cause?.originalCode, "AX001");
  assert.equal(isAmuxLateCommitError(raw), true);
  assert.equal(texts().at(-1), "COMMIT");
});

test("any other COMMIT failure of a mutation is an unknown outcome, a statement timeout included", async () => {
  const { AmuxDbBoundaryError, amuxInternalErrorResponse } = await modules();
  const errors = mock.method(console, "error", () => {});
  try {
    for (const commitError of [
      databaseError("57014", "canceling statement due to statement timeout"),
      databaseError("40001", "could not serialize access"),
      new Error("Connection terminated unexpectedly"),
    ]) {
      reset({ commitError });
      const error = await caught(run(MUTATION));
      assert.ok(error instanceof AmuxDbBoundaryError, commitError.message);
      assert.equal(error.code, "AMUX_DB_OUTCOME_UNKNOWN", commitError.message);
      assert.ok(error.cause, commitError.message);
      const response = amuxInternalErrorResponse("commit_contract", error);
      assert.equal(response.status, 503);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.reason, "amux_outcome_unknown");
      assert.equal(typeof body.incident_id, "string");
      assert.equal(JSON.stringify(body).includes(commitError.message), false);
    }
  } finally {
    errors.mock.restore();
  }
});

test("a statement timeout while the callback runs stays a known rollback and is passed on unchanged", async () => {
  const { AmuxDbBoundaryError } = await modules();
  reset({ callbackError: databaseError("57014", "canceling statement due to statement timeout") });
  const error = await caught(run(MUTATION));
  assert.equal(error instanceof AmuxDbBoundaryError, false);
  assert.equal((error as { code?: unknown }).code, "P2010");
  assert.equal(texts().includes("COMMIT"), false);
  assert.equal(texts().at(-1), "ROLLBACK");
  assert.equal(texts().some((text) => text.includes('AS "withinDeadline"')), false);
});

test("a fence that finds no commit deadline trigger refuses and never commits", async () => {
  const { AmuxDbBoundaryError } = await modules();
  const warnings = mock.method(console, "warn", () => {});
  try {
    reset({ commitCheckInstalled: false });
    const error = await caught(run(MUTATION));
    assert.ok(error instanceof AmuxDbBoundaryError);
    assert.equal(error.code, "AMUX_DB_COMMIT_CHECK_MISSING");
    assert.equal(texts().includes("COMMIT"), false);
    assert.equal(texts().at(-1), "ROLLBACK");
    assert.equal(warnings.mock.callCount(), 1);
    assert.deepEqual(JSON.parse(String(warnings.mock.calls[0]?.arguments[0])), {
      subsystem: "amux",
      event: "commit_deadline_check_missing",
      operation: "commit_contract",
    });

    // Missing wins over a late clock: both roll back, the operator needs this one.
    reset({ commitCheckInstalled: false, fenceWithinDeadline: false });
    const both = await caught(run(MUTATION));
    assert.ok(both instanceof AmuxDbBoundaryError);
    assert.equal(both.code, "AMUX_DB_COMMIT_CHECK_MISSING");
  } finally {
    warnings.mock.restore();
  }
});

test("a fence that finds the deadline passed refuses and never commits", async () => {
  const { AmuxDbBoundaryError } = await modules();
  reset({ fenceWithinDeadline: false });
  const error = await caught(run(MUTATION));
  assert.ok(error instanceof AmuxDbBoundaryError);
  assert.equal(error.code, "AMUX_DB_DEADLINE_EXCEEDED");
  assert.equal(texts().includes("COMMIT"), false);
  assert.equal(texts().at(-1), "ROLLBACK");
});

test("a read transaction writes no marker and a failure of its COMMIT is passed on unchanged", async () => {
  const { AmuxDbBoundaryError } = await modules();
  reset();
  assert.equal(await run(READ), "result");
  const fence = sent.find((entry) => entry.text.includes('AS "withinDeadline"'));
  assert.ok(fence);
  assert.doesNotMatch(fence.text, /AmuxCommitDeadline|INSERT|txid_current/);

  reset({ commitError: databaseError("57014", "canceling statement due to statement timeout") });
  const error = await caught(run(READ));
  assert.equal(error instanceof AmuxDbBoundaryError, false);
  assert.equal((error as { name?: unknown }).name, "DriverAdapterError");
});

test("the route fence records the route deadline less the reserve, and the tick reads AX001 first", async () => {
  const { fenceAmuxRouteDeadline, autoTransactionFailure, AmuxDbBoundaryError } = await modules();
  const deadline = new Date(Date.now() + 20_000);

  reset();
  await prisma.$transaction(async (tx) => {
    await fenceAmuxRouteDeadline(tx, deadline, "auto_promotion");
  });
  const fence = sent.find((entry) => entry.text.includes('AS "withinDeadline"'));
  assert.ok(fence);
  assert.match(fence.text, /INSERT INTO "AmuxCommitDeadline"/);
  assert.ok(fence.values.includes(deadline.toISOString()));
  assert.ok(fence.values.includes(200));
  assert.ok(fence.values.includes("auto_promotion"));

  // No route deadline: nothing is queried and nothing is recorded.
  reset();
  await prisma.$transaction(async (tx) => {
    await fenceAmuxRouteDeadline(tx, null, "auto_promotion");
  });
  assert.equal(sent.some((entry) => entry.text.includes("AmuxCommitDeadline")), false);

  reset({ commitCheckInstalled: false });
  const warnings = mock.method(console, "warn", () => {});
  try {
    const missing = await caught(
      prisma.$transaction(async (tx) => {
        await fenceAmuxRouteDeadline(tx, deadline, "auto_promotion");
      }),
    );
    assert.ok(missing instanceof AmuxDbBoundaryError);
    assert.equal(missing.code, "AMUX_DB_COMMIT_CHECK_MISSING");
  } finally {
    warnings.mock.restore();
  }

  reset({ commitError: databaseError("AX001", "AMUX_LATE_COMMIT") });
  const late = await caught(
    prisma.$transaction(async (tx) => {
      await fenceAmuxRouteDeadline(tx, deadline, "auto_promotion");
    }),
  );
  assert.equal(autoTransactionFailure("committing", late), "deadline_exceeded");
  reset({ commitError: databaseError("57014", "canceling statement due to statement timeout") });
  const cancelled = await caught(
    prisma.$transaction(async (tx) => {
      await fenceAmuxRouteDeadline(tx, deadline, "auto_promotion");
    }),
  );
  assert.equal(autoTransactionFailure("committing", cancelled), "outcome_unknown");
});

test("the internal route answers AX001 as a deadline and a missing trigger as an incident", async () => {
  const { AmuxDbBoundaryError, amuxInternalErrorResponse } = await modules();
  const late = amuxInternalErrorResponse(
    "commit_contract",
    new AmuxDbBoundaryError("AMUX_DB_DEADLINE_EXCEEDED", "commit_contract", {
      cause: databaseError("AX001", "AMUX_LATE_COMMIT"),
    }),
  );
  assert.equal(late.status, 503);
  assert.deepEqual(await late.json(), {
    error: "AMUX database deadline exceeded.",
    reason: "amux_database_deadline_exceeded",
  });

  const errors = mock.method(console, "error", () => {});
  try {
    const missing = amuxInternalErrorResponse(
      "commit_contract",
      new AmuxDbBoundaryError("AMUX_DB_COMMIT_CHECK_MISSING", "commit_contract"),
    );
    assert.equal(missing.status, 503);
    assert.equal(missing.headers.get("Cache-Control"), "no-store");
    const body = (await missing.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["error", "incident_id", "reason"]);
    assert.equal(body.error, "AMUX database commit check is missing.");
    assert.equal(body.reason, "amux_commit_check_missing");
    assert.equal(typeof body.incident_id, "string");
    assert.equal(missing.headers.get("X-AMUX-Incident-ID"), body.incident_id);
    // The incident names the code, so an operator can tell it from any other 503.
    const logged = JSON.parse(String(errors.mock.calls.at(-1)?.arguments[0])) as Record<string, unknown>;
    assert.equal(logged.event, "internal_route_failure");
    assert.equal(logged.error_class, "AmuxDbBoundaryError");
    assert.equal(logged.error_code, "AMUX_DB_COMMIT_CHECK_MISSING");
    assert.equal(logged.incident_id, body.incident_id);
  } finally {
    errors.mock.restore();
  }

  // A missing trigger found by the boundary itself reaches the same answer.
  const warnings = mock.method(console, "warn", () => {});
  const routeErrors = mock.method(console, "error", () => {});
  try {
    reset({ commitCheckInstalled: false });
    const refusal = await caught(run(MUTATION));
    const response = amuxInternalErrorResponse("commit_contract", refusal);
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as Record<string, unknown>).reason, "amux_commit_check_missing");
  } finally {
    warnings.mock.restore();
    routeErrors.mock.restore();
  }
});

// Busy: a failure that wrote nothing, answered 503 `amux_database_busy` so the
// caller asks again next tick (lib/amux/readFailureCore.ts, and the phase table
// on amuxDbBoundaryFailure in lib/amux/dbBoundary.ts).
//
// 2026-09-29: the queue read could not start its transaction within the 250 ms
// maxWait (P2028) and was answered as an unknown outcome. 2026-09-30: the same
// happened to the recovery sweep, a mutation, over and over. A transaction
// whose callback never ran wrote nothing, read or mutation.

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const busyBody = '{"error":"AMUX database is busy.","reason":"amux_database_busy"}';

// Both test boundaries have a 1,400 ms budget (4 calls x 300 ms + 200 ms). A
// 1,700 ms route therefore leaves them a connection wait of about 300 ms
// (amuxDbConnectionWaitMs), and a pool that answers after 450 ms is too slow.
const SHORT_ROUTE_MS = 1_700;
const SLOW_POOL_MS = 450;
// The late connection of a transaction that gave up still arrives, and Prisma
// rolls it back; wait for that so the next test starts from a quiet script.
const LATE_CONNECTION_SETTLE_MS = 500;

type ConsoleMock = ReturnType<typeof mock.method>;
const quietly = async <T>(
  work: (log: { warnings: ConsoleMock; errors: ConsoleMock }) => Promise<T>,
): Promise<T> => {
  const warnings = mock.method(console, "warn", () => {});
  const errors = mock.method(console, "error", () => {});
  try {
    return await work({ warnings, errors });
  } finally {
    warnings.mock.restore();
    errors.mock.restore();
  }
};
const lastWarning = (warnings: ConsoleMock) =>
  JSON.parse(String(warnings.mock.calls.at(-1)?.arguments[0])) as Record<string, unknown>;
const reasonOf = async (response: Response) =>
  ((await response.json()) as Record<string, unknown>).reason;
/** None of the boundary's own SQL: no setup, no callback statement, no fence. */
const boundarySqlSent = () =>
  texts().some(
    (text) =>
      text.includes("tomverse.amux_deadline") ||
      text.includes("callback_statement") ||
      text.includes('AS "withinDeadline"'),
  );

test("the connection wait is the maximum outside a route and the route's slack inside one", async () => {
  const { AMUX_DB_MAX_WAIT_MS, amuxDbConnectionWaitMs } = await modules();
  assert.equal(AMUX_DB_MAX_WAIT_MS, 2_000);
  assert.equal(amuxDbConnectionWaitMs(null, 1_400), 2_000);
  assert.equal(amuxDbConnectionWaitMs(15_000, 1_400), 2_000);
  assert.equal(amuxDbConnectionWaitMs(2_800, 2_000), 800);
  assert.equal(amuxDbConnectionWaitMs(1_700, 1_400), 300);
  assert.equal(amuxDbConnectionWaitMs(1_700.9, 1_400), 300);
  // Prisma refuses a zero maxWait; the admission has already refused less.
  assert.equal(amuxDbConnectionWaitMs(1_400, 1_400), 1);
});

test("a mutation that cannot start within its connection wait wrote nothing and is busy", async () => {
  const { AmuxDbBoundaryError, amuxInternalErrorResponse, withAmuxRouteBudget } = await modules();
  reset({ connectDelayMs: SLOW_POOL_MS });
  await quietly(async ({ warnings, errors }) => {
    const startedAt = Date.now();
    const error = await caught(withAmuxRouteBudget(() => run(MUTATION), SHORT_ROUTE_MS));
    const elapsedMs = Date.now() - startedAt;
    assert.ok(error instanceof AmuxDbBoundaryError);
    assert.equal(error.code, "AMUX_DB_NOT_STARTED");
    // Prisma's own maxWait refusal, from the capped wait, not the 2 s maximum.
    const cause = error.cause as { code?: unknown; message?: unknown };
    assert.equal(cause.code, "P2028");
    assert.match(String(cause.message), /Unable to start a transaction in the given time/);
    assert.ok(elapsedMs < SLOW_POOL_MS, `gave up after ${elapsedMs} ms`);
    assert.ok(
      typeof error.connectionWaitMs === "number" &&
        error.connectionWaitMs > 250 &&
        error.connectionWaitMs <= 300,
      String(error.connectionWaitMs),
    );
    assert.equal(boundarySqlSent(), false, "the callback never ran");

    const response = amuxInternalErrorResponse("execution_recover", error);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "5");
    assert.equal(response.headers.get("X-AMUX-Incident-ID"), null);
    assert.equal(await response.text(), busyBody);
    assert.equal(errors.mock.callCount(), 0, "a busy answer opens no incident");
    assert.deepEqual(lastWarning(warnings), {
      subsystem: "amux",
      event: "internal_route_database_busy",
      operation: "execution_recover",
      path: "not_started",
      error_code: "P2028",
      connection_wait_ms: error.connectionWaitMs,
      pool_total: 10,
      pool_idle: 0,
      pool_waiting: 3,
    });
  });
  await settle(LATE_CONNECTION_SETTLE_MS);
  // The late connection was rolled back without running the callback.
  assert.equal(boundarySqlSent(), false);
  assert.ok(texts().includes("ROLLBACK"));
});

test("a read that cannot start is the same not-started answer", async () => {
  const { AmuxDbBoundaryError, amuxInternalErrorResponse, withAmuxRouteBudget } = await modules();
  reset({ connectDelayMs: SLOW_POOL_MS });
  await quietly(async ({ warnings }) => {
    const error = await caught(withAmuxRouteBudget(() => run(READ), SHORT_ROUTE_MS));
    assert.ok(error instanceof AmuxDbBoundaryError);
    assert.equal(error.code, "AMUX_DB_NOT_STARTED");
    const response = amuxInternalErrorResponse("queue", error);
    assert.equal(await response.text(), busyBody);
    assert.equal(lastWarning(warnings).path, "not_started");
  });
  await settle(LATE_CONNECTION_SETTLE_MS);
});

test("a mutation whose own transaction timeout fires while running is not busy", async () => {
  const { AmuxDbBoundaryError, amuxInternalErrorResponse, withAmuxRouteBudget } = await modules();
  // The budget is 1,400 ms and Prisma's timeout 1,700 ms: the callback's
  // statement outlasts it.
  reset({ callbackDelayMs: 1_900 });
  await quietly(async () => {
    const error = await caught(withAmuxRouteBudget(() => run(MUTATION)));
    assert.notEqual((error as { code?: unknown }).code, "AMUX_DB_NOT_STARTED");
    assert.notEqual((error as { code?: unknown }).code, "AMUX_DB_READ_BUSY");
    assert.equal(error instanceof AmuxDbBoundaryError, false, "passed on from the running phase");
    assert.equal(error.code, "P2028");
    assert.doesNotMatch(String(error.message), /Unable to start a transaction/);
    assert.ok(texts().some((text) => text.includes("callback_statement")), "the callback ran");
    assert.equal(texts().includes("COMMIT"), false);
    // Answered as today: the interactive transaction's timeout is an unknown outcome.
    const response = amuxInternalErrorResponse("execution_settle", error);
    assert.equal(response.status, 503);
    assert.equal(await reasonOf(response), "amux_outcome_unknown");
  });
  await settle(300);
});

test("a read whose own transaction timeout fires while running is a busy read, not a start refusal", async () => {
  const { AmuxDbBoundaryError, withAmuxRouteBudget } = await modules();
  reset({ callbackDelayMs: 1_900 });
  await quietly(async () => {
    const error = await caught(withAmuxRouteBudget(() => run(READ)));
    assert.ok(error instanceof AmuxDbBoundaryError);
    // The read rule, from the running phase: the transaction had started.
    assert.equal(error.code, "AMUX_DB_READ_BUSY");
    assert.equal((error.cause as { code?: unknown }).code, "P2028");
  });
  await settle(300);
});

test("the phase table: the same P2028 is not-started only before the callback ran", async () => {
  const { AmuxDbBoundaryError, amuxDbBoundaryFailure } = await modules();
  const p2028 = Object.assign(new Error("Transaction API error"), { code: "P2028" });
  const p2024 = Object.assign(new Error("Timed out fetching a new connection"), { code: "P2024" });
  const codeOf = (value: unknown) =>
    value instanceof AmuxDbBoundaryError
      ? (value as { code?: unknown }).code
      : value === p2028 || value === p2024
        ? "unchanged"
        : "other";
  const cases: Array<[typeof MUTATION | typeof READ, string, Error, string, string]> = [
    [MUTATION, "starting", p2028, "no_mutation_started", "AMUX_DB_NOT_STARTED"],
    [MUTATION, "starting", p2024, "no_mutation_started", "AMUX_DB_NOT_STARTED"],
    [READ, "starting", p2028, "no_mutation_started", "AMUX_DB_NOT_STARTED"],
    // The interactive transaction's own timeout, once its callback began.
    [MUTATION, "running", p2028, "no_mutation_started", "unchanged"],
    [MUTATION, "committing", p2028, "no_mutation_started", "AMUX_DB_OUTCOME_UNKNOWN"],
    [READ, "running", p2028, "no_mutation_started", "AMUX_DB_READ_BUSY"],
    [READ, "committing", p2028, "no_mutation_started", "AMUX_DB_READ_BUSY"],
    // After a mutation of the route, or outside any route: as before.
    [MUTATION, "starting", p2028, "mutation_started", "unchanged"],
    [READ, "starting", p2028, "mutation_started", "unchanged"],
    [MUTATION, "starting", p2028, "outside_route", "unchanged"],
    [READ, "running", p2028, "outside_route", "unchanged"],
  ];
  for (const [boundary, phase, error, routeWrites, expected] of cases) {
    assert.equal(
      codeOf(amuxDbBoundaryFailure(boundary, phase, error, routeWrites)),
      expected,
      `${boundary.isolation} ${phase} ${error.message} ${routeWrites}`,
    );
  }
  // Only P2024 and P2028 are a start refusal: a mutation's lost connection
  // while starting keeps its old answer.
  const reset_ = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  assert.equal(amuxDbBoundaryFailure(MUTATION, "starting", reset_, "no_mutation_started"), reset_);
});

test("a COMMIT-phase failure of a mutation stays unknown in a route that wrote nothing", async () => {
  const { AmuxDbBoundaryError, amuxInternalErrorResponse, withAmuxRouteBudget } = await modules();
  await quietly(async () => {
    for (const commitError of [
      databaseError("57014", "canceling statement due to statement timeout"),
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read", errno: -104 }),
      Object.assign(new Error("Transaction API error: pool"), { code: "P2028" }),
    ]) {
      reset({ commitError });
      const error = await caught(withAmuxRouteBudget(() => run(MUTATION)));
      assert.ok(error instanceof AmuxDbBoundaryError, commitError.message);
      assert.equal(error.code, "AMUX_DB_OUTCOME_UNKNOWN", commitError.message);
      assert.equal(texts().at(-1), "COMMIT");
      assert.equal(await reasonOf(amuxInternalErrorResponse("execution_settle", error)), "amux_outcome_unknown");
    }

    reset({ commitError: databaseError("AX001", "AMUX_LATE_COMMIT") });
    const late = await caught(withAmuxRouteBudget(() => run(MUTATION)));
    assert.ok(late instanceof AmuxDbBoundaryError);
    assert.equal(late.code, "AMUX_DB_DEADLINE_EXCEEDED");
    assert.equal(await reasonOf(amuxInternalErrorResponse("claim", late)), "amux_database_deadline_exceeded");
  });
});

test("a raw-query statement timeout inside recovery is a known rollback", async () => {
  const { amuxInternalErrorResponse, withAmuxRouteBudget } = await modules();
  await quietly(async () => {
    reset({ callbackError: databaseError("57014", "canceling statement due to statement timeout") });
    const error = await caught(withAmuxRouteBudget(() => run(MUTATION)));
    assert.equal((error as { code?: unknown }).code, "P2010");
    assert.equal(
      await reasonOf(amuxInternalErrorResponse("execution_recover", error)),
      "amux_database_deadline_exceeded",
    );
  });
});

test("a running transaction timeout remains unknown even with a nested statement timeout", async () => {
  const { amuxInternalErrorResponse } = await modules();
  const timeout = Object.assign(new Error("transaction timed out"), {
    code: "P2028",
    meta: { driverAdapterError: { kind: "postgres", code: "57014" } },
  });
  await quietly(async () => {
    assert.equal(
      await reasonOf(amuxInternalErrorResponse("execution_recover", timeout)),
      "amux_outcome_unknown",
    );
  });
});

test("an unrelated outer code does not hide a nested statement timeout", async () => {
  const { amuxInternalErrorResponse } = await modules();
  const timeout = Object.assign(new Error("query canceled"), {
    code: "ABCDE",
    meta: { driverAdapterError: { kind: "postgres", code: "57014" } },
  });
  assert.equal(
    await reasonOf(amuxInternalErrorResponse("execution_recover", timeout)),
    "amux_database_deadline_exceeded",
  );
});

test("a statement timeout or a lost connection in a read of a route that wrote nothing is busy", async () => {
  const { AmuxDbBoundaryError, amuxInternalErrorResponse, withAmuxRouteBudget } = await modules();
  const socketError = Object.assign(new Error("read ECONNRESET"), {
    code: "ECONNRESET",
    syscall: "read",
    errno: -104,
  });
  const cases: Array<[Partial<Script>, string]> = [
    [{ callbackError: databaseError("57014", "canceling statement due to statement timeout") }, "57014"],
    [{ commitError: databaseError("57014", "canceling statement due to statement timeout") }, "57014"],
    [{ commitError: socketError }, "ConnectionClosed"],
    [{ callbackError: databaseError("08006", "connection failure") }, "08006"],
  ];
  for (const [overrides, logged] of cases) {
    reset(overrides);
    await quietly(async ({ warnings }) => {
      const error = await caught(withAmuxRouteBudget(() => run(READ)));
      assert.ok(error instanceof AmuxDbBoundaryError, logged);
      assert.equal(error.code, "AMUX_DB_READ_BUSY", logged);
      const response = amuxInternalErrorResponse("routing_snapshot", error);
      assert.equal(response.status, 503);
      assert.equal(await response.text(), busyBody);
      const warning = lastWarning(warnings);
      assert.equal(warning.path, "read");
      assert.equal(warning.error_code, logged);
      assert.equal(warning.pool_waiting, 3);
    });
  }
});

test("once its route has started a mutation, a transaction that cannot start keeps the unknown outcome", async () => {
  const { AmuxDbBoundaryError, amuxInternalErrorResponse, anchorAmuxRouteDeadline, withAmuxRouteBudget } =
    await modules();
  await quietly(async () => {
    // A committed mutation, then a mutation and a read that cannot start.
    for (const next of [MUTATION, READ]) {
      const afterCommit = await caught(
        withAmuxRouteBudget(async () => {
          reset();
          assert.equal(await run(MUTATION), "result");
          reset({ connectDelayMs: SLOW_POOL_MS });
          return run(next);
        }, SHORT_ROUTE_MS),
      );
      assert.equal(afterCommit instanceof AmuxDbBoundaryError, false, next.isolation);
      assert.equal(afterCommit.code, "P2028", next.isolation);
      assert.equal(
        await reasonOf(amuxInternalErrorResponse("execution_recover", afterCommit)),
        "amux_outcome_unknown",
      );
      await settle(LATE_CONNECTION_SETTLE_MS);
    }

    // A mutation whose callback began marks the route even when it then fails.
    const afterRunning = await caught(
      withAmuxRouteBudget(async () => {
        reset({ callbackError: databaseError("57014", "canceling statement due to statement timeout") });
        await caught(run(MUTATION));
        reset({ connectDelayMs: SLOW_POOL_MS });
        return run(READ);
      }, SHORT_ROUTE_MS),
    );
    assert.equal(afterRunning instanceof AmuxDbBoundaryError, false);
    assert.equal(afterRunning.code, "P2028");
    await settle(LATE_CONNECTION_SETTLE_MS);

    // A transaction that anchors the route deadline itself (the automatic
    // promotion writers) marks the route as well, even when it is refused.
    const afterAnchor = await caught(
      withAmuxRouteBudget(async () => {
        reset();
        await caught(
          prisma.$transaction(async (tx) => {
            await anchorAmuxRouteDeadline(tx, 1_000, "auto_promotion");
          }),
        );
        reset({ callbackError: databaseError("57014", "canceling statement due to statement timeout") });
        return run(READ);
      }),
    );
    assert.equal(afterAnchor instanceof AmuxDbBoundaryError, false);
    assert.equal(afterAnchor.code, "P2010");
  });
});

test("a mutation that never started does not mark its route", async () => {
  const { AmuxDbBoundaryError, withAmuxRouteBudget } = await modules();
  await quietly(async () => {
    // Its callback never ran, so a read after it in the same route is still
    // one of a route that wrote nothing. The mutation's wait is about 300 ms;
    // the read's 1,100 ms budget still fits in what is left.
    const error = await caught(
      withAmuxRouteBudget(async () => {
        reset({ connectDelayMs: SLOW_POOL_MS });
        const notStarted = await caught(run(MUTATION));
        assert.ok(notStarted instanceof AmuxDbBoundaryError);
        assert.equal(notStarted.code, "AMUX_DB_NOT_STARTED");
        reset({ callbackError: databaseError("57014", "canceling statement due to statement timeout") });
        return run(READ_SMALL);
      }, SHORT_ROUTE_MS),
    );
    assert.ok(error instanceof AmuxDbBoundaryError);
    assert.equal(error.code, "AMUX_DB_READ_BUSY");
  });
  await settle(LATE_CONNECTION_SETTLE_MS);
});

test("outside a route, and for any other failure, a transaction keeps its old answer", async () => {
  const { AMUX_DB_MAX_WAIT_MS, AmuxDbBoundaryError, amuxInternalErrorResponse, withAmuxRouteBudget } =
    await modules();
  await quietly(async () => {
    // No route: nothing is known about the caller's earlier writes, and the
    // wait is the whole maximum.
    for (const boundary of [READ, MUTATION]) {
      reset({ connectDelayMs: AMUX_DB_MAX_WAIT_MS + 150 });
      const outside = await caught(run(boundary));
      assert.equal(outside instanceof AmuxDbBoundaryError, false, boundary.isolation);
      assert.equal(outside.code, "P2028", boundary.isolation);
      await settle(400);
    }

    // Not a transient failure: a missing table is a defect, not a busy database.
    reset({ callbackError: databaseError("42P01", "relation does not exist") });
    const defect = await caught(withAmuxRouteBudget(() => run(READ)));
    assert.equal(defect instanceof AmuxDbBoundaryError, false);
    assert.equal(amuxInternalErrorResponse("queue", defect).status, 500);

    // The read's own deadline refusal keeps its reason.
    reset({ fenceWithinDeadline: false });
    const late = await caught(withAmuxRouteBudget(() => run(READ)));
    assert.ok(late instanceof AmuxDbBoundaryError);
    assert.equal(late.code, "AMUX_DB_DEADLINE_EXCEEDED");
    assert.equal(await reasonOf(amuxInternalErrorResponse("queue", late)), "amux_database_deadline_exceeded");
  });
});
