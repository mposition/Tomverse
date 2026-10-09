import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let authorized = false;
let heartbeatCalls = 0;
let settleCalls = 0;
const noStore = (body: unknown, status = 200) => new Response(
  JSON.stringify(body), { status, headers: { "Cache-Control": "no-store" } });

mock.module(mod("lib/amux/guard.ts"), { namedExports: {
  isAmuxSyncAuthorized: () => authorized,
} });
mock.module(mod("lib/amux/dbBoundary.ts"), { namedExports: {
  AMUX_LIFECYCLE_ROUTE_BUDGET_MS: 12_000,
  withAmuxRouteBudget: (work: () => Promise<Response>) => work(),
} });
mock.module(mod("lib/amux/v22TaskExecutionCore.ts"), { namedExports: {
  AMUX_V22_TASK_EXECUTION_CODE_LATCH: true,
} });
mock.module(mod("lib/amux/execution.ts"), { namedExports: {
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
  amuxInternalErrorResponse: () => { throw new Error("unexpected error"); },
  isAmuxInputError: () => false,
} });

test("environment kill switch closes admission without stranding an existing attempt", async () => {
  const previous = process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION;
  process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION = "disabled";
  try {
    for (const name of ["heartbeat", "settle"]) {
      const { POST } = await import(mod(
        `app/api/internal/amux/v22/execution/${name}/route.ts`));
      const body = {
        attempt_id: "00000000-0000-4000-8000-000000000003",
        worker: "worker-one",
        instance_id: "00000000-0000-4000-8000-000000000002",
        generation: 1, task_revision: 2,
        ...(name === "settle" ? { outcome: "blocked", invocation_ids: [] } : {}),
      };
      const request = () => new Request(`https://tomverse.test/${name}`,
        { method: "POST", body: JSON.stringify(body) });
      authorized = false;
      assert.equal((await POST(request())).status, 401);
      authorized = true;
      const response = await POST(request());
      assert.equal(response.status, 409);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await response.json()).reason, "fenced_out");
    }
    assert.equal(heartbeatCalls, 1);
    assert.equal(settleCalls, 1);
  } finally {
    if (previous === undefined) delete process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION;
    else process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION = previous;
  }
});
