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
  closed: Closed;
  closeThrows: Error | null;
  closeCalls: { status: string; error?: string }[];
  incidents: Incident[];
  incidentReporterThrows: Error | null;
};

const world: World = {
  start: { started: true },
  startThrows: null,
  heartbeatThrows: null,
  heartbeat: { beat: true },
  closed: { status: "succeeded" },
  closeThrows: null,
  closeCalls: [],
  incidents: [],
  incidentReporterThrows: null,
};

const resetWorld = () => {
  world.start = { started: true };
  world.startThrows = null;
  world.heartbeatThrows = null;
  world.heartbeat = { beat: true };
  world.closed = { status: "succeeded" };
  world.closeThrows = null;
  world.closeCalls = [];
  world.incidents = [];
  world.incidentReporterThrows = null;
};

let routePromise: Promise<{
  POST: (request: Request) => Promise<Response>;
}> | null = null;

const loadRoute = () => {
  if (!routePromise) {
    mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {} } });
    mock.module(mod("lib/marketingPublisherRun.ts"), {
      namedExports: {
        startMarketingPublisherRun: async () => {
          if (world.startThrows) throw world.startThrows;
          return world.start;
        },
        heartbeatMarketingPublisherRun: async () => {
          if (world.heartbeatThrows) throw world.heartbeatThrows;
          return world.heartbeat;
        },
        finishMarketingPublisherRun: async (
          _client: unknown,
          _runId: string,
          input: { status: string; error?: string },
        ) => {
          world.closeCalls.push({ status: input.status, error: input.error });
          if (world.closeThrows) throw world.closeThrows;
          return world.closed;
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
  // No adapter exists until S2d2, and the run says so rather than looking idle.
  assert.equal(body.skipped, "no_adapter_implemented");
  assert.deepEqual(world.incidents, []);
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
