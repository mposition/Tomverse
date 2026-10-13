import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const state = { reads: 0, writes: 0 };
class Invalid extends Error {}

mock.module(mod("lib/amux/dbBoundary.ts"), { namedExports: {
  AMUX_LIFECYCLE_ROUTE_BUDGET_MS: 12_000,
  withAmuxRouteBudget: async (callback: () => Promise<unknown>) => callback(),
} });
mock.module(mod("lib/amux/internalRoute.ts"), { namedExports: {
  amuxJsonNoStore: (body: unknown, status: number) => Response.json(body,
    { status, headers: { "Cache-Control": "private, no-store" } }),
  isAmuxInputError: (error: unknown) => error instanceof Invalid,
  amuxInternalErrorResponse: () => Response.json({ error: "internal" }, { status: 500 }),
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async () => {}, apiSecurityResponse: () => null,
  readLimitedJson: async (request: Request, limit: number,
    schema: { safeParse: (value: unknown) => { success: boolean; data: unknown } }) => {
    const raw = await request.text();
    if (raw.length > limit) throw new Invalid();
    const result = schema.safeParse(JSON.parse(raw));
    if (!result.success) throw new Invalid();
    return result.data;
  },
} });
mock.module(mod("lib/amux/v22TaskRecoveryService.ts"), { namedExports: {
  pendingAmuxV22LegacySafeStops: async () => {
    state.reads += 1;
    return { requests: [{ requestKind: "safe_stop" }] };
  },
  reportAmuxV22LegacySafeStopEvidence: async () => {
    state.writes += 1;
    return { recorded: true, evidenceId: uuid, verified: true,
      evidenceDigest: "f".repeat(64), reason: null, retryWrite: false };
  },
} });

const route = () => import(mod("app/api/internal/amux/v22/recovery-controller/route.ts"));
const url = "https://tomverse.test/api/internal/amux/v22/recovery-controller";
const uuid = "d3e88810-998d-40ca-8fa7-7655411d99e0";
const secret = "controller-secret-0123456789abcdef";
const headers = { authorization: `Bearer ${secret}`, "content-type": "application/json" };
const report = {
  inspectionId: uuid, evidenceId: uuid, requestKind: "safe_stop",
  requestDigest: "a".repeat(64), taskId: "task-1234", taskRevision: 8,
  priorAttemptId: uuid, priorAttemptTaskRevision: 7, workerName: "claude-test",
  workerInstanceId: uuid, workerGeneration: 2, targetHost: "amux-ubuntu",
  sourceEvidenceId: uuid, sourceEvidenceDigest: "b".repeat(64),
  workerProfileAlias: "profile-one", profileWorkerNames: ["claude-test"],
  targetUnit: "tomverse-amux-v22-sidecar@profile-one.service",
  profileConfigDigest: "c".repeat(64), hostInvocationId: null, modelOutcome: "unknown",
  stopProof: { journalBindingDigest: "d".repeat(64), journalEntryDigest: "e".repeat(64),
    journalDisposition: "intent_recorded", stopAcknowledgement: "acknowledged",
    processState: "gone", fixedUnit: true, rootOwnedConfig: true, profileUnique: true,
    noOtherWork: true, restartDisabled: true, journalBound: true, mainPidAbsent: true,
    controlGroupEmpty: true, kernelProofFresh: true },
  usage: { status: "unknown", projectedCostMicroUsd: null }, reason: "safe_stop_process_gone",
};
const post = (body: unknown, auth = headers.authorization) => new Request(url,
  { method: "POST", headers: { ...headers, authorization: auth }, body: JSON.stringify(body) });
const reset = () => {
  state.reads = 0; state.writes = 0;
  process.env.TOMVERSE_AMUX_V22_TASK_RECOVERY_ENABLED = "true";
  process.env.TOMVERSE_AMUX_V22_LEGACY_SAFE_STOP_ENABLED = "true";
  process.env.TOMVERSE_AMUX_V22_RECOVERY_CONTROLLER_SECRET = secret;
  process.env.TOMVERSE_AMUX_V22_RECOVERY_INSPECTOR_SECRET =
    "different-inspector-secret-0123456789";
  process.env.TOMVERSE_AMUX_SYNC_SECRET = "different-broad-secret-0123456789";
};

test("dedicated root-controller authentication precedes flags, queues, and body parsing", async () => {
  reset(); const { GET, POST } = await route();
  assert.equal((await GET(new Request(url))).status, 401);
  assert.equal((await POST(post({ secret: "must-not-read" }, "Bearer wrong"))).status, 401);
  process.env.TOMVERSE_AMUX_V22_RECOVERY_INSPECTOR_SECRET = secret;
  assert.equal((await GET(new Request(url, { headers }))).status, 401);
  assert.equal((await POST(post(report))).status, 401);
  assert.equal(state.reads + state.writes, 0);
});

test("controller exposes only its pending safe-stop queue and exact 23/14 report", async () => {
  reset(); const { GET, POST } = await route();
  const read = await GET(new Request(url, { headers }));
  assert.equal(read.status, 200); assert.deepEqual(await read.json(),
    { requests: [{ requestKind: "safe_stop" }] });
  assert.equal((await GET(new Request(`${url}?workerName=claude-test`, { headers }))).status, 400);
  for (const extra of [{ path: "/proc/1" }, { stdout: "secret" }, { command: "restart" },
    { hostInvocationId: "a".repeat(32) }])
    assert.equal((await POST(post({ ...report, ...extra }))).status, 400);
  assert.equal(state.writes, 0);
  const response = await POST(post(report));
  assert.equal(response.status, 200); assert.equal(state.writes, 1);
  assert.match(response.headers.get("cache-control")!, /no-store/);
});

test("both exact capability flags close the controller before queue or report work", async () => {
  const { GET, POST } = await route();
  for (const disabled of ["master", "safe-stop"] as const) {
    reset();
    if (disabled === "master") delete process.env.TOMVERSE_AMUX_V22_TASK_RECOVERY_ENABLED;
    else delete process.env.TOMVERSE_AMUX_V22_LEGACY_SAFE_STOP_ENABLED;
    assert.equal((await GET(new Request(url, { headers }))).status, 409);
    assert.equal((await POST(post({ arbitrary: "must not parse" }))).status, 409);
    assert.equal(state.reads + state.writes, 0);
  }
});
