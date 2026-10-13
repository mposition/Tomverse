import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";
const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const state = { authorized: false, reads: 0, writes: 0 };
class Invalid extends Error {}
mock.module(mod("lib/amux/guard.ts"), { namedExports: { isAmuxSyncAuthorized: () => state.authorized } });
mock.module(mod("lib/amux/dbBoundary.ts"), { namedExports: { AMUX_LIFECYCLE_ROUTE_BUDGET_MS: 12_000,
  withAmuxRouteBudget: async (callback: () => Promise<unknown>) => callback() } });
mock.module(mod("lib/amux/internalRoute.ts"), { namedExports: {
  amuxJsonNoStore: (body: unknown, status: number) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } }),
  isAmuxInputError: (error: unknown) => error instanceof Invalid,
  amuxInternalErrorResponse: () => Response.json({ error: "internal" }, { status: 500 }),
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: { consumeApiRateLimit: async () => {}, apiSecurityResponse: () => null,
  readLimitedJson: async (request: Request, limit: number, schema: { safeParse: (value: unknown) => { success: boolean; data: unknown } }) => {
    const raw = await request.text(); if (raw.length > limit) throw new Invalid();
    const result = schema.safeParse(JSON.parse(raw)); if (!result.success) throw new Invalid(); return result.data;
  },
} });
mock.module(mod("lib/amux/v22TaskRecoveryService.ts"), { namedExports: {
  pendingAmuxV22RecoveryInspections: async (workerName: string) => { state.reads++; return { requests: [{ workerName }] }; },
  reportAmuxV22RecoveryEvidence: async () => { state.writes++; return { recorded: true, retryWrite: false }; },
} });
const route = () => import(mod("app/api/internal/amux/v22/recovery-inspection/route.ts"));
const url = "https://tomverse.test/api/internal/amux/v22/recovery-inspection";
const uuid = "d3e88810-998d-40ca-8fa7-7655411d99e0";
const report = { inspectionId: uuid, evidenceId: uuid, requestDigest: "a".repeat(64), taskId: "task-1234",
  taskRevision: 8, priorAttemptId: uuid, priorAttemptTaskRevision: 7, workerName: "claude-test",
  workerInstanceId: uuid, workerGeneration: 1, targetHost: "amux-ubuntu", hostInvocationId: null,
  proof: { terminalOutcome: "unknown", sameLiveInvocation: false, noActiveExecution: false,
    processTreeStopped: false, rootOwnedUnit: false, controlGroupBound: false, journalBound: false,
    socketTerminal: false, externalEffectsKnown: false, workspaceClean: false },
  usage: { status: "unknown", projectedCostMicroUsd: null }, reason: "legacy_invocation_unbound" };
const post = (body: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
test("fixed checker authentication precedes reading pending work or reporting evidence", async () => {
  const { GET, POST } = await route(); state.authorized = false;
  assert.equal((await GET(new Request(`${url}?workerName=claude-test`))).status, 401);
  assert.equal((await POST(post({ secret: "must-not-read" }))).status, 401);
  assert.equal(state.reads + state.writes, 0);
});
test("fixed checker supports a bounded worker queue and refuses raw process output or host commands", async () => {
  const { GET, POST } = await route(); state.authorized = true;
  process.env.TOMVERSE_AMUX_V22_TASK_RECOVERY_ENABLED = "true";
  assert.equal((await GET(new Request(`${url}?workerName=claude-test&command=restart`))).status, 400);
  assert.equal((await GET(new Request(`${url}?workerName=claude-test`))).status, 200);
  for (const extra of [{ path: "/private" }, { stdout: "secret" }, { command: "restart" }])
    assert.equal((await POST(post({ ...report, ...extra }))).status, 400);
  assert.equal(state.writes, 0);
  const response = await POST(post(report)); assert.equal(response.status, 200);
  assert.equal(state.writes, 1); assert.match(response.headers.get("cache-control")!, /no-store/);
});
test("the independent master flag prevents pending lookup and reports before reading the body", async () => {
  const { GET, POST } = await route(); state.authorized = true;
  delete process.env.TOMVERSE_AMUX_V22_TASK_RECOVERY_ENABLED;
  const writes = state.writes; const reads = state.reads;
  assert.equal((await GET(new Request(`${url}?workerName=claude-test`))).status, 409);
  assert.equal((await POST(post({ arbitrary: "must not be parsed" }))).status, 409);
  assert.equal(state.writes, writes); assert.equal(state.reads, reads);
});
