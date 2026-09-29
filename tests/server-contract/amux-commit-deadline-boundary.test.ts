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
    return script.callbackError
      ? Promise.reject(script.callbackError)
      : Promise.resolve(result([["callback_statement", 23]], [1]));
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

mock.module(moduleUrl("lib/prisma.ts"), { namedExports: { prisma } });

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
    ...overrides,
  };
  sent = [];
};

const run = async (boundary: typeof MUTATION | typeof READ) => {
  const { withAmuxDbBoundary } = await modules();
  return withAmuxDbBoundary(boundary, async (tx: PrismaClient) => {
    await tx.$queryRaw`SELECT 1 AS callback_statement`;
    return "result";
  });
};

const texts = () => sent.map((entry) => entry.text);
type Failure = Error & { code?: unknown; cause?: unknown };
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

// A read boundary writes nothing, so its failure is never an unknown outcome.
// When the database could not take it just then, and its route had started no
// transaction that can write, it is answered 503 `amux_database_busy`
// (lib/amux/readFailureCore.ts). The 2026-09-29 production incident was the
// first of these: the queue read could not start its transaction within
// maxWait (P2028) and was answered as an unknown outcome, which stopped the
// orchestrator.

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// The late connection of a transaction that gave up at maxWait still arrives
// and is rolled back; wait for it so the next test starts from a quiet script.
const SLOW_POOL_EXTRA_MS = 150;
const busyBody = '{"error":"AMUX database is busy.","reason":"amux_database_busy"}';

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

test("a read that cannot start within maxWait, in a route that wrote nothing, is busy and never unknown", async () => {
  const { AmuxDbBoundaryError, AMUX_DB_MAX_WAIT_MS, amuxInternalErrorResponse, withAmuxRouteBudget } =
    await modules();
  reset({ connectDelayMs: AMUX_DB_MAX_WAIT_MS + SLOW_POOL_EXTRA_MS });
  await quietly(async ({ warnings, errors }) => {
    const error = await caught(withAmuxRouteBudget(() => run(READ)));
    assert.ok(error instanceof AmuxDbBoundaryError);
    assert.equal(error.code, "AMUX_DB_READ_BUSY");
    // The raw error is Prisma's own, as production logged it.
    const cause = error.cause as { code?: unknown; message?: unknown };
    assert.equal(cause.code, "P2028");
    assert.match(String(cause.message), /Unable to start a transaction in the given time/);

    const response = amuxInternalErrorResponse("queue", error);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "5");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-AMUX-Incident-ID"), null);
    // Byte for byte the body the Rust client matches (DATABASE_BUSY_BODY in
    // tomverse_api.rs, scheduler.rs and wsl_bridge.rs).
    assert.equal(await response.text(), busyBody);
    assert.equal(errors.mock.callCount(), 0, "a busy read opens no incident");
    assert.deepEqual(lastWarning(warnings), {
      subsystem: "amux",
      event: "internal_route_database_busy",
      operation: "queue",
      error_code: "P2028",
    });
  });
  await settle(SLOW_POOL_EXTRA_MS * 2);
});

test("a statement timeout or a lost connection in such a read is busy too", async () => {
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
      assert.equal(lastWarning(warnings).error_code, logged);
    });
  }
});

test("a mutation keeps today's answers: a P2028 and a failed COMMIT are unknown, AX001 is a deadline", async () => {
  const { AmuxDbBoundaryError, AMUX_DB_MAX_WAIT_MS, amuxInternalErrorResponse, withAmuxRouteBudget } =
    await modules();
  await quietly(async () => {
    reset({ connectDelayMs: AMUX_DB_MAX_WAIT_MS + SLOW_POOL_EXTRA_MS });
    const notStarted = await caught(withAmuxRouteBudget(() => run(MUTATION)));
    assert.equal(notStarted instanceof AmuxDbBoundaryError, false);
    assert.equal(notStarted.code, "P2028");
    const unknown = amuxInternalErrorResponse("claim", notStarted);
    assert.equal(unknown.status, 503);
    assert.equal(unknown.headers.get("Retry-After"), null);
    const body = (await unknown.json()) as Record<string, unknown>;
    assert.equal(body.reason, "amux_outcome_unknown");
    assert.equal(typeof body.incident_id, "string");
    await settle(SLOW_POOL_EXTRA_MS * 2);

    for (const commitError of [
      databaseError("57014", "canceling statement due to statement timeout"),
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read", errno: -104 }),
    ]) {
      reset({ commitError });
      const error = await caught(withAmuxRouteBudget(() => run(MUTATION)));
      assert.ok(error instanceof AmuxDbBoundaryError, commitError.message);
      assert.equal(error.code, "AMUX_DB_OUTCOME_UNKNOWN", commitError.message);
      assert.equal(await reasonOf(amuxInternalErrorResponse("claim", error)), "amux_outcome_unknown");
    }

    reset({ commitError: databaseError("AX001", "AMUX_LATE_COMMIT") });
    const late = await caught(withAmuxRouteBudget(() => run(MUTATION)));
    assert.ok(late instanceof AmuxDbBoundaryError);
    assert.equal(late.code, "AMUX_DB_DEADLINE_EXCEEDED");
    assert.equal(await reasonOf(amuxInternalErrorResponse("claim", late)), "amux_database_deadline_exceeded");
  });
});

test("a read that fails after its route started a transaction that can write keeps the unknown outcome", async () => {
  const {
    AmuxDbBoundaryError,
    AMUX_DB_MAX_WAIT_MS,
    amuxInternalErrorResponse,
    anchorAmuxRouteDeadline,
    withAmuxRouteBudget,
  } = await modules();
  const slow = AMUX_DB_MAX_WAIT_MS + SLOW_POOL_EXTRA_MS;
  await quietly(async () => {
    // A committed mutation, then a read that cannot start.
    const afterCommit = await caught(
      withAmuxRouteBudget(async () => {
        reset();
        assert.equal(await run(MUTATION), "result");
        reset({ connectDelayMs: slow });
        return run(READ);
      }),
    );
    assert.equal(afterCommit instanceof AmuxDbBoundaryError, false);
    assert.equal(afterCommit.code, "P2028");
    assert.equal(
      await reasonOf(amuxInternalErrorResponse("execution_recover", afterCommit)),
      "amux_outcome_unknown",
    );
    await settle(SLOW_POOL_EXTRA_MS * 2);

    // A mutation that never started still marks the route: it is marked before BEGIN.
    reset({ connectDelayMs: slow });
    const afterNotStarted = await caught(
      withAmuxRouteBudget(async () => {
        await caught(run(MUTATION));
        return run(READ);
      }),
    );
    assert.equal(afterNotStarted instanceof AmuxDbBoundaryError, false);
    assert.equal(afterNotStarted.code, "P2028");
    await settle(SLOW_POOL_EXTRA_MS * 2);

    // A transaction that anchors the route deadline itself (the automatic
    // promotion writers) marks the route as well, even when it is refused.
    reset();
    const afterAnchor = await caught(
      withAmuxRouteBudget(async () => {
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

test("outside a route, and for any other failure, a read keeps its old answer", async () => {
  const { AmuxDbBoundaryError, AMUX_DB_MAX_WAIT_MS, amuxInternalErrorResponse, withAmuxRouteBudget } =
    await modules();
  await quietly(async () => {
    // No route: nothing is known about the caller's earlier writes.
    reset({ connectDelayMs: AMUX_DB_MAX_WAIT_MS + SLOW_POOL_EXTRA_MS });
    const outside = await caught(run(READ));
    assert.equal(outside instanceof AmuxDbBoundaryError, false);
    assert.equal(outside.code, "P2028");
    await settle(SLOW_POOL_EXTRA_MS * 2);

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
