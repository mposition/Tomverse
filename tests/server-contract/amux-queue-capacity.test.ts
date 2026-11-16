// A queue longer than one wire answer is answered with its head, not refused:
// the selection read keeps the first rows in the orchestrator's own ranking
// (score, oldest, id), and the owned read keeps the oldest rows. A board larger
// than one transaction can score is read oldest first and the rest are logged.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

let todoRows: Array<Record<string, unknown>> = [];
let lastTake: number | undefined;

const fakeTx = {
  appSetting: {
    findUnique: async () => ({
      value: JSON.stringify({
        version: 1,
        state: "normal",
        transition_id: null,
        changed_at: "2026-11-01T00:00:00.000Z",
        reason: "normal operation",
        ticket: "T-1",
      }),
    }),
  },
  amuxWorkItem: {
    findMany: async (args: { take?: number; select?: Record<string, unknown> }) => {
      if (args.take !== undefined) lastTake = args.take;
      return todoRows.slice(0, args.take);
    },
    count: async () => todoRows.length,
  },
  amuxResourcePolicy: { findMany: async () => [] },
};

mock.module(mod("lib/amux/dbBoundary.ts"), {
  namedExports: {
    AMUX_DB_BOUNDARIES: new Proxy({}, { get: () => ({ operation: "x", prismaCallCeiling: 6, isolation: "read" }) }),
    withAmuxDbBoundary: async (_boundary: unknown, work: (tx: unknown, ctx: unknown) => Promise<unknown>) =>
      work(fakeTx, { dbNow: new Date("2026-11-15T00:00:00Z") }),
  },
});
mock.module(mod("lib/prisma.ts"), {
  namedExports: { prisma: fakeTx, prismaPoolUsage: () => null },
});

const row = (index: number, priority: string) => ({
  id: `task-${String(index).padStart(5, "0")}`,
  title: "t",
  kind: "code",
  priority,
  pinned: false,
  drag: 0,
  revision: 1,
  createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, index)),
  dependencies: [],
  dueAt: null,
  duePrecision: null,
  dueSource: null,
  dueRaw: null,
  projectKey: null,
  teamKey: null,
  effortPoints: 1,
  owner: index % 2 === 0 ? null : "worker-a",
  _count: { dependents: 0 },
});

test("a selection queue over the wire limit is answered with its ranked head", async (t) => {
  t.mock.method(console, "warn", () => {});
  const store = await import(mod("lib/amux/store.ts"));
  // The newest row is the only high-priority one: a read cut by age would lose it.
  todoRows = Array.from({ length: store.AMUX_QUEUE_MAX_ITEMS + 40 }, (_, i) =>
    row(i, i === store.AMUX_QUEUE_MAX_ITEMS + 39 ? "p0" : "p3"),
  );
  const queue = await store.listDispatchable();
  assert.equal(queue.length, store.AMUX_QUEUE_MAX_ITEMS);
  assert.equal(queue[0].id, todoRows[store.AMUX_QUEUE_MAX_ITEMS + 39].id);
  const scores = queue.map((task: { scheduler_score: number }) => task.scheduler_score);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores, "head is in score order");
  assert.equal(lastTake, store.AMUX_QUEUE_READ_MAX_ROWS + 1);
});

test("a queue that fits is returned as read; one past the read ceiling scores its oldest rows and logs the rest", async (t) => {
  const store = await import(mod("lib/amux/store.ts"));
  todoRows = Array.from({ length: 10 }, (_, i) => row(i, "p3"));
  assert.equal((await store.listDispatchable()).length, 10);
  // Owner decision 2026-11-15: a board past one read is not refused.
  const warnings: string[] = [];
  t.mock.method(console, "warn", (line: string) => { warnings.push(line); });
  todoRows = Array.from({ length: store.AMUX_QUEUE_READ_MAX_ROWS + 300 }, (_, i) => row(i, "p3"));
  const queue = await store.listDispatchable();
  assert.equal(queue.length, store.AMUX_QUEUE_MAX_ITEMS);
  const read = new Set(todoRows.slice(0, store.AMUX_QUEUE_READ_MAX_ROWS).map((task) => task.id));
  assert.ok(queue.every((task: { id: string }) => read.has(task.id)), "only the oldest rows read are scored");
  const trimmed = warnings.map((line) => JSON.parse(line)).find((event) => event.event === "queue_read_trimmed_to_oldest");
  assert.deepEqual(trimmed, { subsystem: "amux", event: "queue_read_trimmed_to_oldest", queue: "selection",
    read_rows: store.AMUX_QUEUE_READ_MAX_ROWS, unread_rows: 300 });
});

test("an owned queue longer than the wire limit answers its oldest rows instead of refusing", async () => {
  const store = await import(mod("lib/amux/store.ts"));
  todoRows = Array.from({ length: store.AMUX_OWNED_QUEUE_MAX_ITEMS + 25 }, (_, i) => ({
    ...row(i, "p3"),
    owner: "worker-a",
  }));
  const owned = await store.listOwnedTodos();
  assert.equal(owned.length, store.AMUX_OWNED_QUEUE_MAX_ITEMS);
  assert.equal(lastTake, store.AMUX_OWNED_QUEUE_MAX_ITEMS);
});
