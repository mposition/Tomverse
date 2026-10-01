import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * What the marketing publisher route tells the service, and what it records.
 *
 * Two defects this guards, both found by independent review of S2d1:
 *
 * 1. A run the *database* refused to call a success came back as HTTP 200. The
 *    worker treats any 2xx as success and exits 0, so Railway showed a green
 *    execution while the row said `failed` -- two records of one run,
 *    contradicting each other, with nothing saying which to believe.
 * 2. The failure path recorded no operational incident. When the database is
 *    what broke, the close fails too, both errors were swallowed, and the only
 *    trace was a generic 500 and `run_failed` in a worker log nobody reads.
 *
 * The route handler is real. Only the run's database functions, the incident
 * reporter and Prisma are replaced.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

const SECRET = "x".repeat(48);

type Incident = {
  code: string;
  title: string;
  error?: unknown;
  severity?: string;
  context?: Record<string, unknown>;
};

type Closed = { status: "succeeded" | "failed" | "not_running" };

type World = {
  start: { started: true } | { started: false; reason: string };
  startThrows: Error | null;
  heartbeatThrows: Error | null;
  heartbeat: { beat: true } | { beat: false; reason: "not_running" | "past_deadline" };
  /** What the database says the time is, when a test needs it to differ. */
  databaseNow: Date | null;
  closed: Closed;
  closeThrows: Error | null;
  closeCalls: { status: string; error?: string }[];
  incidents: Incident[];
  incidentReporterThrows: Error | null;
  /** What the batch returns, and what it was called with. */
  batch: Record<string, unknown>;
  batchThrows: Error | null;
  batchCalls: { runId: string; deadlineAt: Date; provider: string }[];
  finishInputs: { result?: unknown; processedCount?: number }[];
};

const world: World = {
  start: { started: true },
  startThrows: null,
  heartbeatThrows: null,
  heartbeat: { beat: true },
  databaseNow: null,
  closed: { status: "succeeded" },
  closeThrows: null,
  closeCalls: [],
  incidents: [],
  incidentReporterThrows: null,
  batch: {},
  batchThrows: null,
  batchCalls: [],
  finishInputs: [],
};

const resetWorld = () => {
  world.start = { started: true };
  world.startThrows = null;
  world.heartbeatThrows = null;
  world.heartbeat = { beat: true };
  world.databaseNow = null;
  world.closed = { status: "succeeded" };
  world.closeThrows = null;
  world.closeCalls = [];
  world.incidents = [];
  world.incidentReporterThrows = null;
  world.batch = { claimed: 1, verified: 2, published: 1 };
  world.batchThrows = null;
  world.batchCalls = [];
  world.finishInputs = [];
  delete process.env.ZERNIO_API_KEY;
  delete process.env.MARKETING_AUTOMATION_KILL_SWITCH;
};

let routePromise: Promise<{
  POST: (request: Request) => Promise<Response>;
}> | null = null;

const loadRoute = () => {
  if (!routePromise) {
    mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {} } });
    mock.module(mod("lib/marketingPublisherRun.ts"), {
      namedExports: {
        // The route reads the database clock to judge the deadline window, so the
        // window and the trigger measure lateness with the same clock. The fake
        // answers with a controllable instant; `databaseNow` lets a test make the
        // database disagree with this process, which is the skew the real fix is
        // about.
        marketingPublisherDatabaseNow: async () => world.databaseNow ?? new Date(),
        startMarketingPublisherRun: async () => {
          if (world.startThrows) throw world.startThrows;
          return world.start;
        },
        heartbeatMarketingPublisherRun: async () => {
          if (world.heartbeatThrows) throw world.heartbeatThrows;
          return world.heartbeat;
        },
        // The operations are opaque to the route: it builds them and hands them
        // to the batch, which is replaced below.
        marketingPublisherOperations: () => ({}),
        finishMarketingPublisherRun: async (
          _client: unknown,
          _runId: string,
          input: { status: string; error?: string; result?: unknown; processedCount?: number },
        ) => {
          world.closeCalls.push({ status: input.status, error: input.error });
          world.finishInputs.push({ result: input.result, processedCount: input.processedCount });
          if (world.closeThrows) throw world.closeThrows;
          return world.closed;
        },
      },
    });
    mock.module(mod("lib/marketingPublisherBatch.ts"), {
      namedExports: {
        MARKETING_PUBLISHER_CALL_BUDGET_MS: 30_000,
        runMarketingPublisherBatch: async (
          deps: { adapter: { provider: string } },
          input: { runId: string; deadlineAt: Date },
        ) => {
          world.batchCalls.push({
            runId: input.runId,
            deadlineAt: input.deadlineAt,
            provider: deps.adapter.provider,
          });
          if (world.batchThrows) throw world.batchThrows;
          return world.batch;
        },
      },
    });
    mock.module(mod("lib/operationalMonitoring.ts"), {
      namedExports: {
        reportOperationalIncident: async (incident: Incident) => {
          if (world.incidentReporterThrows) throw world.incidentReporterThrows;
          world.incidents.push(incident);
          return { notified: true, suppressed: false };
        },
      },
    });
    routePromise = import(
      mod("app/api/internal/marketing-publisher/route.ts")
    ) as Promise<{ POST: (request: Request) => Promise<Response> }>;
  }
  return routePromise;
};

const post = async (
  overrides: { runId?: string; deadline?: string; secret?: string } = {},
) => {
  const { POST } = await loadRoute();
  const response = await POST(
    new Request("https://example.test/api/internal/marketing-publisher", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + (overrides.secret ?? SECRET),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runId: overrides.runId ?? randomUUID(),
        deadline:
          overrides.deadline ?? new Date(Date.now() + 4 * 60_000).toISOString(),
      }),
    }),
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
};

process.env.MARKETING_PUBLISH_SECRET = SECRET;

test("a run the database would not call a success is not reported as one", async () => {
  resetWorld();
  // The database's clock said the deadline had passed, so the trigger refused
  // `succeeded` and the row closed `failed`. The service must hear that.
  world.closed = { status: "failed" };

  const { status, body } = await post();

  assert.equal(status, 500);
  assert.equal(body.code, "run_closed_late");
  assert.equal(body.status, "failed");
  // And it is reported, because a run that keeps missing its deadline is an
  // operational fact and not a line in one request's response.
  assert.deepEqual(
    world.incidents.map((incident) => incident.code),
    ["MARKETING_PUBLISHER_RUN_LATE"],
  );
  assert.equal(world.incidents[0]?.context?.component, "marketing-publisher");
});

test("an ordinary run answers 200 and names why it did nothing", async () => {
  resetWorld();
  const { status, body } = await post();
  assert.equal(status, 200);
  assert.equal(body.status, "succeeded");
  // The Zernio adapter exists, but this route is not handed its credential, and
  // the run says so rather than looking idle.
  assert.equal(body.skipped, "no_credential");
  assert.deepEqual(world.incidents, []);
});

test("without the credential the batch never runs", async () => {
  resetWorld();
  const { body } = await post();
  assert.equal(body.skipped, "no_credential");
  assert.deepEqual(world.batchCalls, []);
});

test("with the credential the batch runs once and its counts are what is recorded", async () => {
  resetWorld();
  process.env.ZERNIO_API_KEY = "sk_" + "0".repeat(64);
  const { status, body } = await post();
  assert.equal(status, 200);
  assert.equal(world.batchCalls.length, 1);
  assert.equal(world.batchCalls[0]?.provider, "zernio");
  assert.deepEqual(body.summary, world.batch);
  assert.equal(body.skipped, undefined);
  // The row carries counts and closed codes, never the key or anything a
  // platform said.
  assert.deepEqual(world.finishInputs.at(-1), {
    result: { summary: world.batch },
    processedCount: 3,
  });
  assert.equal(JSON.stringify(body).includes(process.env.ZERNIO_API_KEY), false);
});

test("the kill switch is obeyed before the credential is even read", async () => {
  resetWorld();
  process.env.ZERNIO_API_KEY = "sk_" + "0".repeat(64);
  process.env.MARKETING_AUTOMATION_KILL_SWITCH = "1";
  const { body } = await post();
  assert.equal(body.skipped, "kill_switch");
  assert.deepEqual(world.batchCalls, []);
});

test("a batch that throws fails the run and records an incident", async () => {
  // The batch throws when an outcome could not be recorded -- a post left
  // `publishing` with nobody answering for it -- and that must not look like an
  // ordinary run.
  resetWorld();
  process.env.ZERNIO_API_KEY = "sk_" + "0".repeat(64);
  world.batchThrows = new Error("outcome could not be recorded");
  const { status, body } = await post();
  assert.equal(status, 500);
  assert.equal(body.code, "run_failed");
  assert.deepEqual(
    world.incidents.map((incident) => incident.code),
    ["MARKETING_PUBLISHER_RUN_FAILED"],
  );
  assert.equal(world.closeCalls.at(-1)?.status, "failed");
});

test("a failed run records an incident carrying the original error", async () => {
  resetWorld();
  world.heartbeatThrows = new Error("connection reset");

  const { status, body } = await post();

  assert.equal(status, 500);
  assert.equal(body.code, "run_failed");
  const incident = world.incidents.find(
    (entry) => entry.code === "MARKETING_PUBLISHER_RUN_FAILED",
  );
  assert.ok(incident, "the failure must be reported, not only returned");
  assert.equal((incident?.error as Error)?.message, "connection reset");
  // The row is still closed failed, and with the cause.
  assert.equal(world.closeCalls.at(-1)?.status, "failed");
  assert.match(String(world.closeCalls.at(-1)?.error), /connection reset/);
});

test("a database that broke both the work and the close still reports the cause", async () => {
  resetWorld();
  // The case the swallowed catch hid completely: the heartbeat failed *and* the
  // failure-close failed, so the row stayed `running` and the reason existed
  // nowhere. The silence monitor would eventually notice the row; this says why.
  world.heartbeatThrows = new Error("the database is gone");
  world.closeThrows = new Error("the database is still gone");

  const { status, body } = await post();

  assert.equal(status, 500);
  assert.equal(body.code, "run_failed");
  const incident = world.incidents.find(
    (entry) => entry.code === "MARKETING_PUBLISHER_RUN_FAILED",
  );
  assert.equal((incident?.error as Error)?.message, "the database is gone");
});

test("a reporter that cannot report does not replace the 500 with a crash", async () => {
  resetWorld();
  world.heartbeatThrows = new Error("connection reset");
  world.incidentReporterThrows = new Error("the incident channel is down");

  const { status, body } = await post();

  assert.equal(status, 500);
  assert.equal(body.code, "run_failed");
  // The close still happened: reporting is not a precondition for recording.
  assert.equal(world.closeCalls.at(-1)?.status, "failed");
});

test("a row closed by something else is a conflict, not a success", async () => {
  resetWorld();
  world.closed = { status: "not_running" };
  const { status, body } = await post();
  assert.equal(status, 409);
  assert.equal(body.code, "run_not_running");
  // Not late: nothing said this run missed its deadline.
  assert.deepEqual(world.incidents, []);
});

test("the wrong secret reaches no run function at all", async () => {
  resetWorld();
  const { status } = await post({ secret: "y".repeat(48) });
  assert.equal(status, 401);
  assert.deepEqual(world.closeCalls, []);
});

test("a deadline outside the accepted window is refused before a row exists", async () => {
  resetWorld();
  const cases = [
    [new Date(Date.now() - 1_000).toISOString(), "deadline_passed"],
    [new Date(Date.now() + 60 * 60_000).toISOString(), "deadline_too_far"],
  ] as const;
  for (const [deadline, code] of cases) {
    const { status, body } = await post({ deadline });
    assert.equal(status, 400);
    assert.equal(body.code, code);
  }
  assert.deepEqual(world.closeCalls, []);
});

test("a start that failed for a reason that is not an answer is 503", async () => {
  resetWorld();
  world.startThrows = new Error("could not connect");
  const { status, body } = await post();
  assert.equal(status, 503);
  assert.equal(body.code, "run_start_failed");
  // No row exists, so there is nothing to close.
  assert.deepEqual(world.closeCalls, []);
  // **And it is reported.** This is the one failure with nothing else watching
  // it: every other way a run goes wrong leaves a row, and a row is what the
  // silence monitor reads. A run that could not create one leaves no row, so no
  // silence incident, and no delayed-job warning either, because
  // `marketing_publisher` stays in `PENDING_SCHEDULED_JOB_KEYS` until an
  // operator has applied the catalogue and a first run has been recorded.
  //
  // Asserted because it was not: independent review pointed out that deleting
  // the incident call left this test green, which would have returned the
  // failure to being silent.
  const incident = world.incidents.find(
    (entry) => entry.code === "MARKETING_PUBLISHER_RUN_START_FAILED",
  );
  assert.ok(incident, "a run that could not open its row must be reported");
  assert.equal((incident?.error as Error)?.message, "could not connect");
  assert.equal(incident?.context?.component, "marketing-publisher");
});

test("a duplicate id while the first still runs is answered, not run twice", async () => {
  resetWorld();
  world.start = { started: false, reason: "already_running" };
  const { status, body } = await post();
  assert.equal(status, 202);
  assert.equal(body.code, "already_running");
  assert.deepEqual(world.closeCalls, []);
});

test("a heartbeat the database refused past the deadline stops the run", async () => {
  resetWorld();
  // The service is force-killed at the deadline; the route it called is not.
  // Walking past a refused heartbeat let that route carry on and then ask for
  // `succeeded`, and -- before the trigger refused a late beat -- kept moving the
  // row's last sign of life forward so the silence monitor never saw it.
  world.heartbeat = { beat: false, reason: "past_deadline" };
  world.closed = { status: "failed" };

  const { status, body } = await post();

  assert.equal(status, 500);
  assert.equal(body.code, "heartbeat_past_deadline");
  // Closed failed, with the reason, rather than left running for the monitor to
  // discover fifteen minutes later.
  assert.equal(world.closeCalls.at(-1)?.status, "failed");
  assert.equal(world.closeCalls.at(-1)?.error, "heartbeat_past_deadline");
  // Exactly one close: the success close must not also have been attempted.
  assert.equal(world.closeCalls.length, 1);
});

test("a heartbeat on a row nothing owns any more is a conflict", async () => {
  resetWorld();
  world.heartbeat = { beat: false, reason: "not_running" };
  world.closed = { status: "not_running" };

  const { status, body } = await post();

  assert.equal(status, 409);
  assert.equal(body.code, "heartbeat_not_running");
  assert.equal(world.closeCalls.length, 1);
});

test("a close that also fails after a refused heartbeat still answers", async () => {
  resetWorld();
  world.heartbeat = { beat: false, reason: "past_deadline" };
  world.closeThrows = new Error("the database is gone");

  const { status, body } = await post();

  assert.equal(status, 500);
  assert.equal(body.code, "heartbeat_past_deadline");
  assert.equal(body.status, "not_running");
});

test("the deadline window is judged on the database's clock, not this process's", async () => {
  resetWorld();
  // The skew independent review named: the service and the route agree with each
  // other and are both ahead of PostgreSQL. A deadline four minutes out by their
  // reckoning is further out by the database's, so for that difference the
  // supervisor has already killed the worker while the database still thinks the
  // run is punctual -- and a close asking for `succeeded` is not refused. Reading
  // the deciding clock makes the window mean what it says.
  //
  // Here the database is an hour behind, so a deadline four minutes ahead of
  // *this* process is over an hour ahead of the database: beyond one cron period,
  // and refused.
  world.databaseNow = new Date(Date.now() - 60 * 60_000);

  const { status, body } = await post();

  assert.equal(status, 400);
  assert.equal(body.code, "deadline_too_far");
  assert.deepEqual(world.closeCalls, [], "no row is opened for a deadline we refuse");
});

test("a database clock that cannot be read is not guessed at", async () => {
  resetWorld();
  // Failing closed: a window this route cannot measure is one it must not accept,
  // because the trigger will measure it with the clock we could not read.
  const { POST } = await loadRoute();
  world.databaseNow = null;
  const previous = world.startThrows;
  world.startThrows = previous;
  // Make the clock read itself fail by pointing the fake at a getter that throws.
  Object.defineProperty(world, "databaseNow", {
    configurable: true,
    get() {
      throw new Error("no connection");
    },
  });
  const response = await POST(
    new Request("https://example.test/api/internal/marketing-publisher", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + SECRET,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runId: randomUUID(),
        deadline: new Date(Date.now() + 4 * 60_000).toISOString(),
      }),
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 503);
  assert.equal(body.code, "database_clock_unavailable");
  // Restore an ordinary property so later tests are unaffected.
  Object.defineProperty(world, "databaseNow", {
    configurable: true,
    writable: true,
    value: null,
  });
});

test("a service thirty seconds ahead of the database is refused", async () => {
  // The band the hour-long skew test walked straight past, and the one that
  // actually breaks the mandatory invariant. The window's upper bound used to be
  // the cron period (five minutes) while a run's deadline is four, so a service
  // half a minute ahead of PostgreSQL submitted `db_now + 4m30s` and was
  // accepted. The supervisor then killed the worker at its own four minutes while
  // the database still had thirty seconds left, so a close asking for `succeeded`
  // at 4m15s was not late by the only clock the trigger consults.
  //
  // With the bound at the run deadline, any forward skew pushes the deadline past
  // it and the run never opens.
  for (const skewMs of [1_000, 30_000, 59_000]) {
    resetWorld();
    world.databaseNow = new Date(Date.now() - skewMs);
    const { status, body } = await post();
    assert.equal(status, 400, `skew ${skewMs}ms must be refused`);
    assert.equal(body.code, "deadline_too_far");
    assert.deepEqual(world.closeCalls, []);
  }
});

test("clocks that agree still accept an ordinary deadline", async () => {
  // The other direction: the bound must not be so tight that the request's own
  // latency refuses every run. With agreeing clocks `deadline - now` is just under
  // four minutes, because the service computed it before the request was made.
  resetWorld();
  world.databaseNow = new Date(Date.now() + 500);
  const { status } = await post();
  assert.equal(status, 200);
});

test("a clock that cannot be read is reported, not just logged", async () => {
  resetWorld();
  Object.defineProperty(world, "databaseNow", {
    configurable: true,
    get() {
      throw new Error("no connection");
    },
  });
  const { POST } = await loadRoute();
  const response = await POST(
    new Request("https://example.test/api/internal/marketing-publisher", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + SECRET,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runId: randomUUID(),
        deadline: new Date(Date.now() + 4 * 60_000).toISOString(),
      }),
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 503);
  assert.equal(body.code, "database_clock_unavailable");
  // No row exists, so the silence monitor cannot see this and the job is still
  // pending in the catalogue -- the operational queue is the only place it can
  // land.
  const incident = world.incidents.find(
    (entry) => entry.code === "MARKETING_PUBLISHER_CLOCK_UNAVAILABLE",
  );
  assert.ok(incident, "a clock failure must reach the operational queue");
  assert.equal((incident?.error as Error)?.message, "no connection");
  Object.defineProperty(world, "databaseNow", {
    configurable: true,
    writable: true,
    value: null,
  });
});
