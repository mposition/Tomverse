import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const calls: Array<{ type: string; args: unknown }> = [];
let total = 60;
let scoreRows: unknown[] = [];
let rows = [{ id: "card-a", sourceKey: "CHAT-01", revision: 3, title: "Private\nsummary",
  createdAt: new Date("2026-10-10T00:00:00Z") }];
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  amuxWorkItem: {
    count: async (args: unknown) => { calls.push({ type: "count", args }); return total; },
    findMany: async (args: unknown) => { calls.push({ type: "find", args }); return rows; },
  },
  $queryRaw: async (...args: unknown[]) => { calls.push({ type: "score", args }); return scoreRows; },
} } });
mock.module(mod("lib/amux/adminExecutionRead.ts"), { namedExports: {
  readAmuxCardTitle: async (row: { title: string }) => row.title,
} });
const loader = import(mod("lib/amux/adminBacklogRead.ts"));

test("server search applies to the whole backlog and out-of-range pages use the final page", async () => {
  const { readAmuxBacklogList } = await loader;
  const result = await readAmuxBacklogList("chat-01", 999);
  assert.equal(result.total, 60);
  assert.equal(result.page, 2);
  assert.equal(result.pageCount, 2);
  const count = calls.find((call) => call.type === "count")!.args as { where: unknown };
  const find = calls.find((call) => call.type === "find")!.args as { where: unknown; skip: number; take: number };
  assert.deepEqual(count.where, find.where);
  assert.equal(find.skip, 50);
  assert.equal(find.take, 50);
  assert.equal(result.rows[0].summary, "Private summary");
  assert.equal(result.rows[0].score, null);
});

test("only the current revision's saved score is shown, with expired evidence marked stale", async () => {
  const { readAmuxBacklogList } = await loader;
  scoreRows = [{ taskId: "card-a", taskRevision: 2, scoreTotal: 90, activeStaleAt: new Date("2099-01-01") }];
  assert.equal((await readAmuxBacklogList("", 1)).rows[0].score, null);
  scoreRows = [{ taskId: "card-a", taskRevision: 3, scoreTotal: 0, activeStaleAt: new Date("2000-01-01") }];
  const result = await readAmuxBacklogList("", 1);
  assert.equal(result.rows[0].score, 0);
  assert.equal(result.rows[0].scoreFresh, false);
});

test("empty backlog pages do not query scores", async () => {
  const { readAmuxBacklogList } = await loader;
  rows = []; total = 0; calls.length = 0;
  const result = await readAmuxBacklogList("missing", 3);
  assert.deepEqual(result.rows, []);
  assert.equal(result.page, 1);
  assert.equal(result.total, 0);
  assert.equal(calls.some((call) => call.type === "score"), false);
});
