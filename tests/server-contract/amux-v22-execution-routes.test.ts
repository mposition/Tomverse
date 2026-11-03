import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let authorized = false;
let startReachedService = false;
let permitStart = false;
let readbackCalls = 0;
let heartbeatCalls = 0;
let settleCalls = 0;
let settleInput: unknown = null;
let startInput: { publicationBaseSha?: string | null } | null = null;
let developHead: () => Promise<string> = async () => "a".repeat(40);
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
  startAmuxV22TaskExecution: async (input: { publicationBaseSha?: string | null }) => {
    startReachedService = true;
    startInput = input;
    assert.equal(permitStart, true, "disabled start reached a service");
    return { started: true,
      attemptId: "00000000-0000-4000-8000-000000000003",
      taskRevision: 2,
      leaseExpiresAt: new Date("2026-10-10T12:00:00Z") };
  },
  readAmuxV22TaskExecution: async () => { readbackCalls += 1;
    return { found: true, state: "not_started" }; },
  heartbeatAmuxV22TaskExecution: async () => { heartbeatCalls += 1;
    return false; },
  settleAmuxV22TaskExecution: async (input: unknown) => { settleCalls += 1;
    settleInput = input;
    return { settled: false, reason: "fenced_out" }; },
} });
class EngineeringAgentGitHubReadError extends Error {
  constructor(readonly code: string) { super(code); }
}
mock.module(mod("lib/engineeringAgentGitHubRead.ts"), { namedExports: {
  EngineeringAgentGitHubReadError,
  readEngineeringAgentDevelopHead: () => developHead(),
} });
mock.module(mod("lib/engineeringAgentStore.ts"), { namedExports: {
  readEngineeringAgentSwitches: async () => ({ publishAllowed: true }),
} });
mock.module(mod("lib/amux/v22PublicPrConsent.ts"), { namedExports: {
  readAmuxV22PublicPrConsent: async () => true,
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {} } });
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

test("v22 disabled admission permits only authenticated read-back and fenced attempt drainage", async () => {
  const previous = process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION;
  process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION = "disabled";
  try {
    startReachedService = false;
    permitStart = false;
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
      const result = await disabled.json();
      if (name === "start") assert.equal(result.reason, "v22_execution_disabled");
      if (name === "heartbeat" || name === "settle")
        assert.equal(result.reason, "fenced_out");
    }
    assert.equal(startReachedService, false);
    assert.equal(readbackCalls, 1);
    assert.equal(heartbeatCalls, 1);
    assert.equal(settleCalls, 1);
  } finally {
    if (previous === undefined) delete process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION;
    else process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION = previous;
  }
});

test("v22 exact enabled admission reaches start only after authentication", async () => {
  const previous = process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION;
  process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION = "enabled";
  try {
    const { call } = (await routes).find(({ name }) => name === "start")!;
    const request = () => new Request(
      "https://tomverse.test/api/internal/amux/v22/execution/start", {
        method: "POST", body: JSON.stringify({
          task_id: "task-one",
          assignment_id: "00000000-0000-4000-8000-000000000001",
          worker: "worker-one",
          instance_id: "00000000-0000-4000-8000-000000000002",
          generation: 1, expected_revision: 1,
        }),
      });
    startReachedService = false;
    permitStart = true;
    authorized = false;
    assert.equal((await call(request())).status, 401);
    assert.equal(startReachedService, false);
    authorized = true;
    const response = await call(request());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).started, true);
    assert.equal(startReachedService, true);
  } finally {
    permitStart = false;
    if (previous === undefined) delete process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION;
    else process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION = previous;
  }
});

test("v22 start logs why publication was skipped and still starts the Task", async () => {
  const saved = { exec: process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION,
    publication: process.env.TOMVERSE_AMUX_V22_ENGINEERING_PUBLICATION };
  process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION = "enabled";
  process.env.TOMVERSE_AMUX_V22_ENGINEERING_PUBLICATION = "enabled";
  const warnings: string[] = [];
  const warn = mock.method(console, "warn", (line: string) => { warnings.push(line); });
  try {
    const { call } = (await routes).find(({ name }) => name === "start")!;
    const start = () => call(new Request(
      "https://tomverse.test/api/internal/amux/v22/execution/start", {
        method: "POST", body: JSON.stringify({
          task_id: "task-one",
          assignment_id: "00000000-0000-4000-8000-000000000001",
          worker: "worker-one",
          instance_id: "00000000-0000-4000-8000-000000000002",
          generation: 1, expected_revision: 1,
        }),
      }));
    authorized = true;
    permitStart = true;
    developHead = async () => { throw new EngineeringAgentGitHubReadError("http_error"); };
    assert.equal((await start()).status, 200);
    assert.equal(startInput?.publicationBaseSha, null);
    assert.deepEqual(warnings.map((line) => JSON.parse(line)), [{
      subsystem: "amux", event: "v22_publication_skipped",
      taskId: "task-one", reason: "develop_head_http_error" }]);
    warnings.length = 0;
    developHead = async () => "b".repeat(40);
    assert.equal((await start()).status, 200);
    assert.equal(startInput?.publicationBaseSha, "b".repeat(40));
    assert.deepEqual(warnings, []);
  } finally {
    warn.mock.restore();
    permitStart = false;
    developHead = async () => "a".repeat(40);
    for (const [name, value] of [
      ["TOMVERSE_AMUX_V22_TASK_EXECUTION", saved.exec],
      ["TOMVERSE_AMUX_V22_ENGINEERING_PUBLICATION", saved.publication]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("v22 settlement maps the strict read-only API receipt echo", async () => {
  const { call } = (await routes).find(({ name }) => name === "settle")!;
  authorized = true;
  settleInput = null;
  const digest = "a".repeat(64);
  const apiExecutionReceipt = { version: 1,
    executorKind: "read_only_api_retry_v1", digest: "b".repeat(64) };
  const response = await call(new Request(
    "https://tomverse.test/api/internal/amux/v22/execution/settle", {
      method: "POST", body: JSON.stringify({
        attempt_id: "00000000-0000-4000-8000-000000000003",
        worker: "worker-one",
        instance_id: "00000000-0000-4000-8000-000000000002",
        generation: 1, task_revision: 2, outcome: "succeeded",
        invocation_ids: ["00000000-0000-4000-8000-000000000003"],
        read_only_retry: { version: 1,
          launch_binding_id: "00000000-0000-4000-8000-000000000004",
          launch_proof_digest: digest, launch_scope_digest: digest,
          executor_kind: "read_only_api_retry_v1",
          launcher_config_digest: digest,
          api_execution_frame_digest: digest,
          api_execution_receipt: apiExecutionReceipt },
      }),
    }));
  assert.equal(response.status, 409);
  assert.deepEqual(settleInput, {
    attemptId: "00000000-0000-4000-8000-000000000003",
    worker: "worker-one",
    instanceId: "00000000-0000-4000-8000-000000000002",
    generation: 1, taskRevision: 2, outcome: "succeeded",
    invocationIds: ["00000000-0000-4000-8000-000000000003"],
    readOnlyRetry: { version: 1,
      launchBindingId: "00000000-0000-4000-8000-000000000004",
      launchProofDigest: digest, launchScopeDigest: digest,
      executorKind: "read_only_api_retry_v1",
      launcherConfigDigest: digest, apiExecutionFrameDigest: digest,
      apiExecutionReceipt },
  });
});
