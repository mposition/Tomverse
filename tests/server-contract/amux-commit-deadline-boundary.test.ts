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
(pool as unknown as { connect: () => Promise<unknown> }).connect = async () => connection;
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
