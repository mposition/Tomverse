// One stored card whose id or owner fails the canonical machine-id rule must
// not turn the whole selection or owned queue into a 500. main accepted any
// trimmed id up to 120 characters; this app's claim, routing-snapshot and
// execution-start requests refuse a non-canonical one, so the queue routes
// drop that row, report the count (never the id) and answer 200 with the
// rest. Any other schema violation still fails closed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;
const queueWire = JSON.parse(
  readFileSync(resolve(ROOT, "tests/fixtures/amux-queue-wire-compat-v1.json"), "utf8"),
);

let selectionRows: unknown[] = [];
let ownedRows: unknown[] = [];

class TestBoundaryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

mock.module(mod("lib/amux/guard.ts"), {
  namedExports: { isAmuxSyncAuthorized: () => true },
});
mock.module(mod("lib/amux/executionGate.ts"), {
  namedExports: { isAmuxExecutionApiEnabled: () => true },
});
mock.module(mod("lib/amux/dbBoundary.ts"), {
  namedExports: {
    AmuxDbBoundaryError: TestBoundaryError,
    withAmuxRouteBudget: <T>(work: () => Promise<T>) => work(),
  },
});
mock.module(mod("lib/amux/store.ts"), {
  namedExports: {
    AMUX_QUEUE_MAX_ITEMS: 512,
    AMUX_OWNED_QUEUE_MAX_ITEMS: 512,
    AmuxQueueCapacityError: class extends Error {},
    listDispatchable: async () => selectionRows,
    listOwnedTodos: async () => ownedRows,
  },
});

const post = async (path: "queue" | "owned-queue") => {
  const route = (await import(mod(`app/api/internal/amux/${path}/route.ts`))) as {
    POST: (request: Request) => Promise<Response>;
  };
  return route.POST(
    new Request(`https://tomverse.app/api/internal/amux/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
};

const warnLines = (calls: { arguments: unknown[] }[]) =>
  calls
    .map((call) => String(call.arguments[0]))
    .filter((line) => line.includes('"queue_rows_rejected"'));

test("the selection queue drops a non-canonical id and answers 200 with the rest", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  selectionRows = [
    queueWire.queue_server,
    { ...queueWire.queue_server, id: "TASK-trailing-" },
  ];

  const response = await post("queue");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [queueWire.queue_server]);
  const lines = warnLines(warn.mock.calls);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    subsystem: "amux",
    event: "queue_rows_rejected",
    queue: "selection",
    reason: "non_canonical_machine_id",
    rejected_rows: 1,
    kept_rows: 1,
  });
  assert.doesNotMatch(lines[0], /TASK-trailing-/);
});

test("the owned queue drops a non-canonical id or owner and answers 200 with the rest", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  ownedRows = [
    queueWire.owned_server,
    { ...queueWire.owned_server, id: "TASK 2" },
    { ...queueWire.owned_server, id: "TASK-3", owner: "worker-" },
  ];

  const response = await post("owned-queue");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [queueWire.owned_server]);
  const lines = warnLines(warn.mock.calls);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).queue, "owned");
  assert.equal(JSON.parse(lines[0]).rejected_rows, 2);
  assert.doesNotMatch(lines[0], /TASK 2|TASK-3|worker-/);
});

test("a queue whose every row is rejected is an empty queue, not an error", async (t) => {
  t.mock.method(console, "warn", () => {});
  selectionRows = [{ ...queueWire.queue_server, id: "-TASK" }];

  const response = await post("queue");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
});

test("any other schema violation still fails closed", async (t) => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  selectionRows = [{ ...queueWire.queue_server, kind: "" }];

  const response = await post("queue");

  assert.equal(response.status, 500);
});
