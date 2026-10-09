import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let authorized = false;
let startReachedService = false;
let readbackCalls = 0;
let heartbeatCalls = 0;
let settleCalls = 0;
const noStore = (body: unknown, status = 200) => new Response(
  JSON.stringify(body), { status, headers: { "Cache-Control": "no-store" } });
const unexpected = () => { startReachedService = true;
  throw new Error("dark v22 execution reached a service"); };

mock.module(mod("lib/amux/guard.ts"), { namedExports: {
  isAmuxSyncAuthorized: () => authorized,
} });
mock.module(mod("lib/amux/dbBoundary.ts"), { namedExports: {
  AMUX_LIFECYCLE_ROUTE_BUDGET_MS: 12_000,
  withAmuxRouteBudget: (work: () => Promise<Response>) => work(),
} });
mock.module(mod("lib/amux/execution.ts"), { namedExports: {
  startAmuxV22TaskExecution: unexpected,
  readAmuxV22TaskExecution: async () => { readbackCalls += 1;
    return { found: true, state: "not_started" }; },
  heartbeatAmuxV22TaskExecution: async () => { heartbeatCalls += 1;
    return false; },
  settleAmuxV22TaskExecution: async () => { settleCalls += 1;
    return { settled: false, reason: "fenced_out" }; },
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  readLimitedJson: async (request: Request, _limit: number,
    schema: { parse: (value: unknown) => unknown }) =>
    schema.parse(JSON.parse(await request.text())),
} });
mock.module(mod("lib/amux/internalRoute.ts"), { namedExports: {
  amuxJsonNoStore: noStore,
  amuxInternalErrorResponse: unexpected,
  isAmuxInputError: () => false,
} });

const routes = Promise.all([
  "start", "heartbeat", "settle", "attempt",
].map(async (name) => {
  const loaded = await import(mod(`app/api/internal/amux/v22/execution/${name}/route.ts`));
  return { name, call: name === "attempt" ? loaded.GET : loaded.POST };
}));

test("v22 code-latch-off writes stay dark while authenticated read-back remains available", async () => {
  startReachedService = false;
  readbackCalls = 0;
  heartbeatCalls = 0;
  settleCalls = 0;
  for (const { name, call } of await routes) {
    authorized = false;
    const body = name === "start" ? {
      task_id: "task-one", assignment_id: "00000000-0000-4000-8000-000000000001",
      worker: "worker-one", instance_id: "00000000-0000-4000-8000-000000000002",
      generation: 1, expected_revision: 1,
    } : {
      attempt_id: "00000000-0000-4000-8000-000000000003",
      worker: "worker-one", instance_id: "00000000-0000-4000-8000-000000000002",
      generation: 1, task_revision: 2,
      ...(name === "settle" ? { outcome: "blocked", invocation_ids: [] } : {}),
    };
    const request = () => new Request(
      `https://tomverse.test/api/internal/amux/v22/execution/${name}` +
        (name === "attempt" ?
          "?assignment_id=00000000-0000-4000-8000-000000000001" +
          "&worker=worker-one&instance_id=00000000-0000-4000-8000-000000000002" +
          "&generation=1" : ""),
      name === "attempt" ? undefined : { method: "POST",
        body: JSON.stringify(body) });
    const unauthorized = await call(request());
    assert.equal(unauthorized.status, 401, name);
    assert.equal(unauthorized.headers.get("cache-control"), "no-store");
    authorized = true;
    const disabled = await call(request());
    assert.equal(disabled.status, name === "attempt" ? 200 : 409, name);
    assert.equal(disabled.headers.get("cache-control"), "no-store");
  }
  assert.equal(startReachedService, false);
  assert.equal(readbackCalls, 1);
  assert.equal(heartbeatCalls, 0);
  assert.equal(settleCalls, 0);
});
