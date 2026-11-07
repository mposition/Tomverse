import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";
const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const state = { reads: 0, writes: 0 };
class Invalid extends Error {}
class RateLimited extends Error {}
// A day-bucket fake of consumeApiRateLimit: records which key and scope each
// call used, and refuses once a (scope, key) bucket passes its day limit.
const dayBuckets = new Map<string, number>();
const limitCalls: Array<{ key: string; scope: string; skipIpBucket: boolean | undefined }> = [];
mock.module(mod("lib/amux/dbBoundary.ts"), { namedExports: { AMUX_LIFECYCLE_ROUTE_BUDGET_MS: 12_000,
  withAmuxRouteBudget: async (callback: () => Promise<unknown>) => callback() } });
mock.module(mod("lib/amux/internalRoute.ts"), { namedExports: {
  amuxJsonNoStore: (body: unknown, status: number) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } }),
  isAmuxInputError: (error: unknown) => error instanceof Invalid,
  amuxInternalErrorResponse: () => Response.json({ error: "internal" }, { status: 500 }),
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async (_request: Request, key: string, scope: string,
    limits: { minute: number; day: number }, options: { skipIpBucket?: boolean } = {}) => {
    limitCalls.push({ key, scope, skipIpBucket: options.skipIpBucket });
    const bucket = `${scope}|${key}`; const count = (dayBuckets.get(bucket) ?? 0) + 1;
    if (count > limits.day) throw new RateLimited(); dayBuckets.set(bucket, count);
  },
  apiSecurityResponse: (error: unknown) => error instanceof RateLimited ?
    Response.json({ error: "API_RATE_LIMITED" }, { status: 429 }) : null,
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
const inspectorSecret = "i".repeat(40);
const broadSyncSecret = "s".repeat(40);
const controllerSecret = "r".repeat(40);
const report = { inspectionId: uuid, evidenceId: uuid, requestDigest: "a".repeat(64), taskId: "task-1234",
  taskRevision: 8, priorAttemptId: uuid, priorAttemptTaskRevision: 7, workerName: "claude-test",
  workerInstanceId: uuid, workerGeneration: 1, targetHost: "amux-ubuntu", hostInvocationId: null,
  proof: { terminalOutcome: "unknown", sameLiveInvocation: false, noActiveExecution: false,
    processTreeStopped: false, rootOwnedUnit: false, controlGroupBound: false, journalBound: false,
    socketTerminal: false, externalEffectsKnown: false, workspaceClean: false },
  usage: { status: "unknown", projectedCostMicroUsd: null }, reason: "legacy_invocation_unbound" };
// Seed workers (lib/amux/workerRegistryCore.ts); the recovery profile config
// stays unset, so per-worker buckets cannot depend on it.
const seedReport = { ...report, workerName: "claude-impl" };
const authorizedHeaders = (secret = inspectorSecret) => ({
  authorization: `Bearer ${secret}`,
});
const get = (query: string, secret = inspectorSecret) => new Request(`${url}?${query}`, {
  headers: authorizedHeaders(secret),
});
const post = (body: unknown, secret = inspectorSecret) => new Request(url, { method: "POST",
  headers: { "content-type": "application/json", ...authorizedHeaders(secret) },
  body: JSON.stringify(body) });
test("fixed checker authentication precedes reading pending work or reporting evidence", async () => {
  const { GET, POST } = await route();
  process.env.TOMVERSE_AMUX_V22_RECOVERY_INSPECTOR_SECRET = inspectorSecret;
  process.env.TOMVERSE_AMUX_SYNC_SECRET = broadSyncSecret;
  process.env.TOMVERSE_AMUX_V22_RECOVERY_CONTROLLER_SECRET = controllerSecret;
  assert.equal((await GET(new Request(`${url}?workerName=claude-test`))).status, 401);
  assert.equal((await GET(get("workerName=claude-test", broadSyncSecret))).status, 401);
  assert.equal((await POST(post({ secret: "must-not-read" }, controllerSecret))).status, 401);
  process.env.TOMVERSE_AMUX_V22_RECOVERY_INSPECTOR_SECRET = broadSyncSecret;
  assert.equal((await GET(get("workerName=claude-test", broadSyncSecret))).status, 401);
  process.env.TOMVERSE_AMUX_V22_RECOVERY_INSPECTOR_SECRET = controllerSecret;
  assert.equal((await POST(post({ secret: "must-not-read" }, controllerSecret))).status, 401);
  assert.equal(state.reads + state.writes, 0);
});
test("fixed checker supports a bounded worker queue and refuses raw process output or host commands", async () => {
  const { GET, POST } = await route();
  process.env.TOMVERSE_AMUX_V22_RECOVERY_INSPECTOR_SECRET = inspectorSecret;
  process.env.TOMVERSE_AMUX_SYNC_SECRET = broadSyncSecret;
  process.env.TOMVERSE_AMUX_V22_RECOVERY_CONTROLLER_SECRET = controllerSecret;
  process.env.TOMVERSE_AMUX_V22_TASK_RECOVERY_ENABLED = "true";
  assert.equal((await GET(get("workerName=claude-test&command=restart"))).status, 400);
  assert.equal((await GET(get("workerName=claude-impl"))).status, 200);
  for (const extra of [{ path: "/private" }, { stdout: "secret" }, { command: "restart" }])
    assert.equal((await POST(post({ ...report, ...extra }))).status, 400);
  assert.equal(state.writes, 0);
  const response = await POST(post(seedReport)); assert.equal(response.status, 200);
  assert.equal(state.writes, 1); assert.match(response.headers.get("cache-control")!, /no-store/);
});
test("the independent master flag prevents pending lookup and reports before reading the body", async () => {
  const { GET, POST } = await route();
  process.env.TOMVERSE_AMUX_V22_RECOVERY_INSPECTOR_SECRET = inspectorSecret;
  process.env.TOMVERSE_AMUX_SYNC_SECRET = broadSyncSecret;
  process.env.TOMVERSE_AMUX_V22_RECOVERY_CONTROLLER_SECRET = controllerSecret;
  delete process.env.TOMVERSE_AMUX_V22_TASK_RECOVERY_ENABLED;
  const writes = state.writes; const reads = state.reads;
  assert.equal((await GET(get("workerName=claude-impl"))).status, 409);
  assert.equal((await POST(post({ arbitrary: "must not be parsed" }))).status, 409);
  assert.equal(state.writes, writes); assert.equal(state.reads, reads);
});
const enableInspector = () => {
  process.env.TOMVERSE_AMUX_V22_RECOVERY_INSPECTOR_SECRET = inspectorSecret;
  process.env.TOMVERSE_AMUX_V22_TASK_RECOVERY_ENABLED = "true";
  delete process.env.TOMVERSE_AMUX_V22_RECOVERY_PROFILES_JSON;
  dayBuckets.clear(); limitCalls.length = 0;
};
test("each seed worker has its own daily bucket and no shared IP leg", async () => {
  const { GET, POST } = await route();
  enableInspector();
  for (let call = 0; call < 2_000; call++)
    assert.equal((await GET(get("workerName=claude-impl"))).status, 200);
  assert.equal((await GET(get("workerName=claude-impl"))).status, 429);
  assert.equal((await GET(get("workerName=copilot-worker"))).status, 200);
  assert.equal((await POST(post(seedReport))).status, 200);
  assert.equal((await POST(post({ ...report, workerName: "copilot-worker" }))).status, 200);
  assert.deepEqual(new Set(limitCalls.map((call) => `${call.scope}|${call.key}`)), new Set([
    "amux-recovery-inspection-read|amux-fixed-recovery-checker:claude-impl",
    "amux-recovery-inspection-read|amux-fixed-recovery-checker:copilot-worker",
    "amux-recovery-inspection-report|amux-fixed-recovery-checker:claude-impl",
    "amux-recovery-inspection-report|amux-fixed-recovery-checker:copilot-worker"]));
  assert.ok(limitCalls.every((call) => call.skipIpBucket === true));
});
test("the same worker is held to its report day limit", async () => {
  const { POST } = await route();
  enableInspector();
  for (let call = 0; call < 1_000; call++)
    assert.equal((await POST(post(seedReport))).status, 200);
  assert.equal((await POST(post(seedReport))).status, 429);
  assert.equal((await POST(post({ ...report, workerName: "copilot-worker" }))).status, 200);
});
test("an invalid or non-seed worker name never creates a worker bucket", async () => {
  const { GET, POST } = await route();
  enableInspector();
  for (const name of ["", "claude test", "../claude", "x".repeat(129)])
    assert.equal((await GET(get(`workerName=${encodeURIComponent(name)}`))).status, 400);
  assert.equal((await POST(post({ ...report, workerName: "claude test" }))).status, 400);
  assert.equal(limitCalls.length, 0);
  assert.equal((await GET(get("workerName=rogue-1"))).status, 200);
  assert.equal((await GET(get("workerName=rogue-2"))).status, 200);
  assert.equal((await POST(post({ ...report, workerName: "rogue-3" }))).status, 200);
  assert.deepEqual([...new Set(limitCalls.map((call) => call.key))], ["amux-fixed-recovery-checker"]);
  process.env.TOMVERSE_AMUX_V22_RECOVERY_PROFILES_JSON = JSON.stringify({ version: 1,
    profiles: [{ alias: "rogue", workerNames: ["rogue-1"] }] });
  limitCalls.length = 0;
  assert.equal((await GET(get("workerName=rogue-1"))).status, 200);
  assert.deepEqual(limitCalls.map((call) => call.key), ["amux-fixed-recovery-checker"]);
});
